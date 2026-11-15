import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import { wrapEmbeddingModel } from 'ai';

import {
  type CalibrationKind,
  Calibrations,
} from '../calibration/calibrations.ts';
import { TemperatureScaling } from '../calibration/temperature-scaling.ts';
import { Matrix } from '../gradients/matrix.ts';
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
// The fewest and the most rows that a calibration fits (venn/server.py:471).
const MIN_CALIBRATION_ROWS = 200;
const MAX_CALIBRATION_ROWS = 10_000;
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
  readonly #calibrations: Calibrations;
  readonly #handles = new QuestionHandles();

  private constructor(
    head: CosineAbstention,
    vectors: Vectors,
    temperature: number,
    calibrations: Calibrations,
  ) {
    this.#head = head;
    this.#vectors = vectors;
    this.#temperature = temperature;
    this.#calibrations = calibrations;
  }

  // `registryPath` is the file of the temperatures that registerCalibration
  // fits, Venn's registry_path (venn/server.py:91).
  static async load(options: {
    readonly model: Model;
    readonly database: DatabaseSync;
    readonly directory: string;
    readonly registryPath: string;
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
      await Calibrations.open(options.registryPath),
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
    for (const [name, question] of questions) {
      const asked =
        question.questionRef === undefined
          ? question
          : this.#handles.question(question);
      // venn/server.py:958
      answers[name] = await this.#answer(
        asked,
        state,
        asked.family ?? request.family ?? '',
      );
    }
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

  // Fits the temperature of the questions of a family and type to 200 to
  // 10,000 labelled rows of logits, as Venn's register_calibration does
  // (venn/server.py:465-478): the logits are float32 numbers, and each target
  // is the column of its row's answer. The temperature goes into
  // calibrations.json, and decide divides the logits of those questions by
  // it.
  registerCalibration(
    family: string,
    logits: readonly (readonly number[])[],
    targets: readonly number[],
    kind: CalibrationKind = 'Choice',
  ): number {
    const columns = logits[0]?.length ?? 0;
    if (
      logits.length < MIN_CALIBRATION_ROWS ||
      logits.length > MAX_CALIBRATION_ROWS ||
      targets.length !== logits.length ||
      logits.some((row) => row.length !== columns)
    )
      throw new ContractError(
        'calibration_size',
        'Register 200..10000 labeled logits',
      );
    const values = Matrix.fromRows(logits.map((row) => Float32Array.from(row)));
    if (
      !values.values.every(Number.isFinite) ||
      !targets.every(
        (target) => Number.isInteger(target) && target >= 0 && target < columns,
      )
    )
      throw new ContractError(
        'calibration_labels',
        'Invalid calibration labels or logits',
      );
    const temperature = TemperatureScaling.fit(values, targets);
    this.#calibrations.set(family, kind, temperature);
    return temperature;
  }

  // Removes the temperature of a family and type, if there is one, as Venn's
  // delete_calibration does (venn/server.py:480-483).
  deleteCalibration(family: string, kind: CalibrationKind = 'Choice'): void {
    this.#calibrations.delete(family, kind);
  }

  // IndexApply reads the temperature of Choice (venn/server.py:804).
  static #calibrationKind(question: Question): CalibrationKind {
    if (question.type === undefined || question.type === 'IndexApply')
      return 'Choice';
    return question.type;
  }

  // The answer to one question about the state, as Venn's decide gives it
  // (venn/server.py:960-1115). The logits divide by the temperature of the
  // family and the type of the question, else by choice_temperature
  // (venn/server.py:803-805).
  async #answer(
    question: Question,
    state: StateVectors,
    family: string,
  ): Promise<Answer> {
    const { sources, kind } = new CheckedQuestion(
      question,
      state,
      this.#vectors,
      this.#calibrations.temperature(
        family,
        DecisionService.#calibrationKind(question),
      ) ?? this.#temperature,
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
