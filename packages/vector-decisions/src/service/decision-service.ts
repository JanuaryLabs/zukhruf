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
  IndexApplyQuestion,
  IndexBatch,
  IndexValue,
  OptionQuestion,
  Question,
  StreamedRef,
} from './decision.ts';
import { IndexStream } from './index-stream.ts';
import { type Index, Indexes, type LabelledIndex } from './indexes.ts';
import { NearestReference } from './nearest-reference.ts';
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
// The most rows of an index (venn/server.py:432).
const MAX_INDEX_ROWS = 1_000_000;
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
  readonly #indexes = new Indexes();

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
    // Venn reads the index of a state before it reads the other kinds
    // (venn/server.py:936).
    const state =
      typeof request.state === 'object' && request.state.indexRef !== undefined
        ? this.#indexState(request.state.indexRef)
        : await this.#vectors.state(request.state);
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
    question: OptionQuestion & { readonly threshold?: never },
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

  // Registers 1 to 1,000,000 rows, each with an id, and for NearestReference
  // an outcome, as Venn's register_index does (venn/server.py:427-443): the
  // rows are checked as decide checks given vectors, and kept as unit
  // float32 vectors. The handle names the index in a state { indexRef }, a
  // NearestReference question and streamIndex.
  registerIndex(
    vectors: readonly (readonly number[])[],
    ids: readonly IndexValue[],
    outcomes?: readonly IndexValue[],
  ): string {
    return this.#indexes.register(
      this.#vectors.rows(vectors, MAX_INDEX_ROWS),
      ids,
      outcomes,
    );
  }

  // The index of a handle of registerIndex (venn/server.py:459-463).
  index(handle: string): Index | LabelledIndex {
    return this.#indexes.index(handle);
  }

  // Answers an IndexApply question about each row of an index, in batches,
  // as Venn's stream_index does (venn/server.py:869-910). The checks run in
  // Venn's order when it is called, so a refusal rejects the promise before
  // the caller reads a batch: the index, the questionRef, rowCap and
  // batchSize (up to 1,000,000 rows), the threshold, then the question. The
  // generator answers each batch when the caller reads it, as Venn's
  // generator does.
  async streamIndex(
    handle: string,
    question: IndexApplyQuestion | StreamedRef,
  ): Promise<Generator<IndexBatch, void, undefined>> {
    const index = this.#indexes.index(handle);
    const { question: registered, merged } =
      question.questionRef === undefined
        ? { question, merged: question }
        : this.#handles.streamed(question);
    const stream = new IndexStream(
      merged.threshold,
      this.#calibrations.temperature(merged.family ?? '', 'Choice') ??
        this.#temperature,
      index.vectors,
      index.ids,
      merged.rowCap,
      merged.batchSize,
    );
    DecisionService.#checkThreshold(merged.threshold);
    const sources = new QuestionSources(registered, this.#vectors);
    const [instructions = new Float32Array(), ...options] =
      await this.#vectors.resolve([sources.instructions, ...sources.options]);
    return stream.batches(
      new PreparedQuestion(this.#head, instructions, options),
      sources.labels,
    );
  }

  #indexState(handle: string): StateVectors {
    const { vectors, ids } = this.#indexes.index(handle);
    return { from: 'index', rows: vectors, ids };
  }

  // A threshold from 0 to 1, as Venn checks it for each question of decide
  // and for stream_index (venn/server.py:886-887, 962-963).
  static #checkThreshold(threshold: number | undefined): void {
    if (threshold !== undefined && !(threshold >= 0 && threshold <= 1))
      throw new ContractError('threshold', 'Threshold must be in [0,1]');
  }

  // IndexApply reads the temperature of Choice (venn/server.py:804).
  static #calibrationKind(question: OptionQuestion): CalibrationKind {
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
    DecisionService.#checkThreshold(question.threshold);
    if (question.type === 'NearestReference')
      return new NearestReference(
        question,
        this.#indexes.index(question.indexRef),
        state,
        this.#calibrations.temperature(family, 'NearestReference') ??
          this.#temperature,
      ).answer();
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
