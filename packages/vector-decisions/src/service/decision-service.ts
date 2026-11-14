import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import { wrapEmbeddingModel } from 'ai';

import { CosineAbstention } from '../head/cosine-abstention.ts';
import { PreparedQuestion } from '../head/prepared-question.ts';
import { InvalidModelArtifactError } from '../model-bundle/invalid-model-artifact-error.ts';
import { modelDirectory } from '../model-bundle/model-directory.ts';
import { embeddingGemmaPrompt } from '../reader/embedding-gemma-prompt.ts';
import { vectorCache } from '../reader/vector-cache.ts';
import { loadWeights } from '../safetensors/load-weights.ts';
import { CheckedQuestion } from './checked-question.ts';
import { ContractError } from './contract-error.ts';
import type {
  Answer,
  Decision,
  DecisionRequest,
  Question,
} from './decision.ts';
import { QuestionHandles } from './question-handles.ts';
import { QuestionSources } from './question-sources.ts';
import { type StateVectors, Vectors } from './vectors.ts';

// An AI SDK embedding model, as wrapEmbeddingModel takes it.
type Model = Parameters<typeof wrapEmbeddingModel>[0]['model'];

// The reader whose vectors the venn-1 head reads (venn/server.py:71).
const READER = {
  id: 'google/embeddinggemma-2',
  revision: 'f9972ac22e696a105c482202646979e33e4b5a1e',
  dimensions: 768,
};

const MAX_QUESTIONS = 32;
// The types that registerQuestion prepares (venn/server.py:860).
const REGISTERED = new Set<Question['type']>([
  undefined,
  'Choice',
  'Score',
  'Noul',
  'IndexApply',
]);

export class DecisionService {
  readonly #head: CosineAbstention;
  readonly #vectors: Vectors;
  readonly #temperature: number;
  readonly #handles = new QuestionHandles();

  private constructor(
    head: CosineAbstention,
    vectors: Vectors,
    temperature: number,
  ) {
    this.#head = head;
    this.#vectors = vectors;
    this.#temperature = temperature;
  }

  static async load(options: {
    readonly model: Model;
    readonly database: DatabaseSync;
    readonly directory: string;
  }): Promise<DecisionService> {
    const directory = await modelDirectory(options.directory);
    const temperature = await DecisionService.#choiceTemperature(directory);
    const head = CosineAbstention.fromWeights(
      await loadWeights(join(directory, 'universal.safetensors')),
    );
    const reader = wrapEmbeddingModel({
      model: options.model,
      middleware: [
        embeddingGemmaPrompt('Classification'),
        vectorCache({ database: options.database }),
      ],
    });
    return new DecisionService(
      head,
      new Vectors(reader, head.width),
      temperature,
    );
  }

  // The choice_temperature of the config.json of a head over the reader
  // that venn-1 reads, as Venn's DecisionService reads it
  // (venn/server.py:70-77).
  static async #choiceTemperature(directory: string): Promise<number> {
    const config: unknown = JSON.parse(
      await readFile(join(directory, 'config.json'), 'utf8'),
    );
    if (
      typeof config !== 'object' ||
      config === null ||
      !('reader' in config) ||
      !isDeepStrictEqual(config.reader, READER) ||
      !('choice_temperature' in config) ||
      typeof config.choice_temperature !== 'number'
    )
      throw new InvalidModelArtifactError(
        'config.json',
        `is not the config of a head over ${READER.id} at ${READER.revision}, with ${READER.dimensions} numbers, and a choice_temperature`,
      );
    return config.choice_temperature;
  }

  async decide(request: DecisionRequest): Promise<Decision> {
    const questions = Object.entries(request.questions);
    // venn/server.py:921
    if (questions.length < 1 || questions.length > MAX_QUESTIONS)
      throw new ContractError(
        'question_limit',
        `Provide 1..${MAX_QUESTIONS} questions`,
      );
    const state = await this.#vectors.state(request.state);
    const answers: Record<string, Answer> = {};
    for (const [name, question] of questions)
      answers[name] = await this.#answer(
        question.questionRef === undefined
          ? question
          : this.#handles.question(question),
        state,
      );
    return { answers, vector: DecisionService.#embedded(state) };
  }

  // Prepares a question for many decisions, as Venn's register_question does
  // (venn/server.py:854-867): it checks the question, the reader embeds its
  // texts into the vector cache, and a questionRef names the question by
  // the handle. Each decision gives the threshold.
  async registerQuestion(
    question: Question & { readonly threshold?: never },
  ): Promise<string> {
    if (!REGISTERED.has(question.type))
      throw new ContractError(
        'prewarm_type',
        'This type has no option prewarm handle',
      );
    const sources = new QuestionSources(question, this.#vectors);
    await this.#vectors.resolve([sources.instructions, ...sources.options]);
    return this.#handles.register(question);
  }

  // The answer to one question about the state, as Venn's decide gives it
  // (venn/server.py:960-1115).
  async #answer(question: Question, state: StateVectors): Promise<Answer> {
    const { sources, kind } = new CheckedQuestion(
      question,
      state,
      this.#vectors,
      this.#temperature,
    );
    const [instructions = new Float32Array(), ...options] =
      await this.#vectors.resolve([sources.instructions, ...sources.options]);
    return kind.answer(
      new PreparedQuestion(this.#head, instructions, options),
      sources.labels,
    );
  }

  // The vectors of a state that the reader embedded, as Venn's decide gives
  // them (venn/server.py:1116, 1124).
  static #embedded(state: StateVectors): Decision['vector'] {
    switch (state.from) {
      case 'text':
        return Array.from(state.vector);
      case 'texts':
        return state.rows.map((row) => Array.from(row));
      default:
        return null;
    }
  }
}
