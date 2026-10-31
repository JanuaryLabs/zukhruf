import type { TaskMetadata } from '../abstasks/task-metadata.ts';
import type { TimingStack } from '../timing.ts';
import type {
  BatchedInput,
  CorpusDatasetType,
  Embeddings,
  EncodeKwargs,
  PromptType,
  QueryDatasetType,
  RetrievalOutputType,
  TopRankedDocumentsType,
} from '../types/encoder-io.ts';
import type { ModelMeta } from './model-meta.ts';

// mteb/models/models_protocols.py. A Python Protocol is an interface, and
// runtime_checkable's isinstance is a type guard that looks for the methods.

export type EncodeOptions = EncodeKwargs & {
  // Encoders choose their prompts from the metadata of the task: the task
  // name with the prompt type first, then the task name, the task type with
  // the prompt type, the task type, and the prompt type.
  readonly taskMetadata: TaskMetadata;
  readonly hfSplit: string;
  readonly hfSubset: string;
  readonly promptType?: PromptType | null;
};

// A model that gives one embedding for each input.
export interface EncoderProtocol {
  encode(
    inputs: readonly BatchedInput[],
    options: EncodeOptions,
  ): Promise<Embeddings>;
  // The similarity of each embedding of embeddings1 with each of embeddings2.
  similarity(embeddings1: Embeddings, embeddings2: Embeddings): Float32Array[];
  // The similarity of each pair of embeddings at the same index.
  similarityPairwise(
    embeddings1: Embeddings,
    embeddings2: Embeddings,
  ): Float32Array;
  readonly mtebModelMeta: ModelMeta;
}

export type PredictOptions = EncodeKwargs & {
  readonly taskMetadata: TaskMetadata;
  readonly hfSplit: string;
  readonly hfSubset: string;
  readonly promptType?: PromptType | null;
};

// A model that scores pairs of inputs: inputs1[i] with inputs2[i]. Unlike an
// encoder, it sees both inputs of a pair at once.
export interface CrossEncoderProtocol {
  // One score for each pair, in the order of the pairs.
  predict(
    inputs1: readonly BatchedInput[],
    inputs2: readonly BatchedInput[],
    options: PredictOptions,
  ): Promise<Float32Array>;
  readonly mtebModelMeta: ModelMeta;
}

export type IndexOptions = {
  readonly taskMetadata: TaskMetadata;
  readonly hfSplit: string;
  readonly hfSubset: string;
  readonly encodeKwargs: EncodeKwargs;
};

export type SearchOptions = IndexOptions & {
  readonly topK: number;
  // The candidates of each query, for reranking tasks.
  readonly topRanked?: TopRankedDocumentsType | null;
  readonly timer?: TimingStack;
};

// A model that indexes a corpus and searches it.
export interface SearchProtocol {
  index(corpus: CorpusDatasetType, options: IndexOptions): Promise<void>;
  // The score of each document that the search found, for each query.
  search(
    queries: QueryDatasetType,
    options: SearchOptions,
  ): Promise<RetrievalOutputType>;
  readonly mtebModelMeta: ModelMeta;
}

export function isEncoder(model: unknown): model is EncoderProtocol {
  return (
    typeof model === 'object' &&
    model !== null &&
    'encode' in model &&
    typeof model.encode === 'function' &&
    'similarity' in model &&
    typeof model.similarity === 'function' &&
    'similarityPairwise' in model &&
    typeof model.similarityPairwise === 'function'
  );
}

export function isSearch(model: unknown): model is SearchProtocol {
  return (
    typeof model === 'object' &&
    model !== null &&
    'index' in model &&
    typeof model.index === 'function' &&
    'search' in model &&
    typeof model.search === 'function'
  );
}

export function isCrossEncoder(model: unknown): model is CrossEncoderProtocol {
  return (
    typeof model === 'object' &&
    model !== null &&
    'predict' in model &&
    typeof model.predict === 'function'
  );
}
