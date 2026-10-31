// heap is a port of CPython's heapq. MTEB gives the documents of a search in
// the order of the heap array.
import Heap from 'heap';

import type { TaskMetadata } from '../abstasks/task-metadata.ts';
import {
  type PreparedRow,
  collate,
  createDataloader,
  createDataloaderDataset,
} from '../create-dataloaders.ts';
import {
  type ScoredId,
  compareScoredIds,
  zipStrictMismatch,
} from '../dependencies/python.ts';
import { TimingStack } from '../timing.ts';
import type {
  BatchedInput,
  CorpusDatasetType,
  Embeddings,
  EncodeKwargs,
  QueryDatasetType,
  RetrievalOutputType,
  TopRankedDocumentsType,
} from '../types/encoder-io.ts';
import type { ModelMeta } from './model-meta.ts';
import type {
  CrossEncoderProtocol,
  EncodeOptions,
  EncoderProtocol,
  IndexOptions,
  SearchOptions,
  SearchProtocol,
} from './models-protocols.ts';

// mteb/models/search_wrappers.py: SearchEncoderWrapper and its two searches,
// and SearchCrossEncoderWrapper. Search index backends are not ported yet.

type Location = {
  readonly taskMetadata: TaskMetadata;
  readonly hfSplit: string;
  readonly hfSubset: string;
};

type Encode = (
  inputs: readonly BatchedInput[],
  options: EncodeOptions,
) => Promise<Embeddings>;

type Similarity = (
  embeddings1: Embeddings,
  embeddings2: Embeddings,
) => Float32Array[];

// torch.topk(scores, k, largest=True): the indices of the k greatest scores,
// greatest first. torch does not fix the order of equal scores; here the
// lower index comes first.
function topk(scores: Float32Array, k: number): number[] {
  return Array.from(scores, (_, index) => index)
    .sort(
      (left, right) =>
        (scores[right] ?? 0) - (scores[left] ?? 0) || left - right,
    )
    .slice(0, k);
}

// Encodes the corpus in chunks, scores each chunk against the queries, and
// keeps the topK documents of each query in a heap.
async function chunkedFullCorpusSearch(
  options: Location & {
    readonly taskCorpus: CorpusDatasetType;
    readonly corpusChunkSize: number;
    readonly queryIdxToId: ReadonlyMap<number, string>;
    readonly queryEmbeddings: Embeddings;
    readonly topK: number;
    readonly encodeKwargs: EncodeKwargs;
    readonly encodeFn: Encode;
    readonly similarityFn: Similarity;
    readonly searchKOffset?: number;
    readonly timer?: TimingStack;
  },
): Promise<Map<string, ScoredId[]>> {
  const timer = options.timer ?? new TimingStack();
  const heaps = new Map<string, ScoredId[]>(
    [...options.queryIdxToId.values()].map((query) => [query, []]),
  );
  using _ = timer.phase('Searching corpus', {
    split: options.hfSplit,
    subset: options.hfSubset,
  });
  for (
    let start = 0;
    start < options.taskCorpus.length;
    start += options.corpusChunkSize
  ) {
    const chunk = options.taskCorpus.slice(
      start,
      Math.min(start + options.corpusChunkSize, options.taskCorpus.length),
    );
    const embeddings = await options.encodeFn(
      createDataloader(chunk, {
        taskMetadata: options.taskMetadata,
        promptType: 'document',
        batchSize: options.encodeKwargs.batchSize ?? 32,
      }),
      {
        ...options.encodeKwargs,
        taskMetadata: options.taskMetadata,
        hfSplit: options.hfSplit,
        hfSubset: options.hfSubset,
        promptType: 'document',
      },
    );
    const scores = options.similarityFn(options.queryEmbeddings, embeddings);
    const k = Math.min(
      options.topK + (options.searchKOffset ?? 0),
      chunk.length,
    );
    for (const [queryIndex, query] of options.queryIdxToId) {
      const row = scores[queryIndex] ?? new Float32Array();
      const heap = heaps.get(query) ?? [];
      for (const index of topk(row, k)) {
        const item: ScoredId = [row[index] ?? 0, chunk[index]?.id ?? ''];
        if (heap.length < options.topK) Heap.push(heap, item, compareScoredIds);
        else Heap.pushpop(heap, item, compareScoredIds);
      }
    }
  }
  return heaps;
}

// Encodes the whole corpus once, then ranks the candidates of each query.
async function rerankTopRankedDocuments(
  options: Location & {
    readonly taskCorpus: CorpusDatasetType;
    readonly queryIdxToId: ReadonlyMap<number, string>;
    readonly queryEmbeddings: Embeddings;
    readonly topRanked: TopRankedDocumentsType;
    readonly topK: number;
    readonly encodeKwargs: EncodeKwargs;
    readonly encodeFn: Encode;
    readonly similarityFn: Similarity;
    readonly timer?: TimingStack;
  },
): Promise<Map<string, ScoredId[]>> {
  const timer = options.timer ?? new TimingStack();
  const heaps = new Map<string, ScoredId[]>(
    [...options.queryIdxToId.values()].map((query) => [query, []]),
  );
  const documentIndex = new Map(
    options.taskCorpus.map((document, index) => [document.id, index]),
  );
  const location = { split: options.hfSplit, subset: options.hfSubset };
  let documents: Embeddings;
  {
    using _ = timer.phase('Encoding corpus', location);
    documents = await options.encodeFn(
      createDataloader(options.taskCorpus, {
        taskMetadata: options.taskMetadata,
        promptType: 'document',
        batchSize: options.encodeKwargs.batchSize ?? 32,
      }),
      {
        ...options.encodeKwargs,
        taskMetadata: options.taskMetadata,
        hfSplit: options.hfSplit,
        hfSubset: options.hfSubset,
        promptType: 'document',
      },
    );
  }
  using _ = timer.phase('Computing similarity', location);
  for (const [queryIndex, query] of options.queryIdxToId) {
    const candidates = options.topRanked.get(query);
    if (candidates === undefined || candidates.length === 0) continue;
    const candidateEmbeddings = candidates.map((id) => {
      const index = documentIndex.get(id);
      if (index === undefined) throw new Error(`KeyError: '${id}'`);
      return documents[index] ?? new Float32Array();
    });
    const queryEmbedding = options.queryEmbeddings[queryIndex];
    const scores =
      options.similarityFn(
        queryEmbedding === undefined ? [] : [queryEmbedding],
        candidateEmbeddings,
      )[0] ?? new Float32Array();
    const nan = scores.filter(Number.isNaN).length;
    if (nan > 0)
      throw new Error(`NaN values detected in the similarity scores: ${nan}`);
    const heap = heaps.get(query) ?? [];
    for (const index of topk(scores, Math.min(options.topK, candidates.length)))
      Heap.push(
        heap,
        [scores[index] ?? 0, candidates[index] ?? ''],
        compareScoredIds,
      );
  }
  return heaps;
}

// An encoder as a search model: it keeps the corpus at index time, and
// encodes it at search time.
export class SearchEncoderWrapper implements SearchProtocol {
  readonly model: EncoderProtocol;
  readonly mtebModelMeta: ModelMeta;
  readonly corpusChunkSize: number;
  taskCorpus: CorpusDatasetType | null = null;

  constructor(
    model: EncoderProtocol,
    options: { readonly corpusChunkSize?: number } = {},
  ) {
    this.model = model;
    this.mtebModelMeta = model.mtebModelMeta;
    this.corpusChunkSize = options.corpusChunkSize ?? 50_000;
  }

  async index(
    corpus: CorpusDatasetType,
    _options: IndexOptions,
  ): Promise<void> {
    this.taskCorpus = corpus;
  }

  async search(
    queries: QueryDatasetType,
    options: SearchOptions,
  ): Promise<RetrievalOutputType> {
    const corpus = this.taskCorpus;
    if (corpus === null)
      throw new Error('Corpus must be indexed before searching.');
    const timer = options.timer ?? new TimingStack();
    const location = {
      taskMetadata: options.taskMetadata,
      hfSplit: options.hfSplit,
      hfSubset: options.hfSubset,
    };
    let queryEmbeddings: Embeddings;
    {
      using _ = timer.phase('Encoding queries', {
        split: options.hfSplit,
        subset: options.hfSubset,
      });
      queryEmbeddings = await this.model.encode(
        createDataloader(queries, {
          taskMetadata: options.taskMetadata,
          promptType: 'query',
          batchSize: options.encodeKwargs.batchSize ?? 32,
        }),
        { ...options.encodeKwargs, ...location, promptType: 'query' },
      );
    }
    const queryIdxToId = new Map(
      queries.map((query, index) => [index, query.id]),
    );
    const shared = {
      ...location,
      taskCorpus: corpus,
      queryIdxToId,
      queryEmbeddings,
      topK: options.topK,
      encodeKwargs: options.encodeKwargs,
      encodeFn: (inputs: readonly BatchedInput[], encode: EncodeOptions) =>
        this.model.encode(inputs, encode),
      similarityFn: (left: Embeddings, right: Embeddings) =>
        this.model.similarity(left, right),
      timer,
    };
    const heaps =
      options.topRanked !== undefined && options.topRanked !== null
        ? await rerankTopRankedDocuments({
            ...shared,
            topRanked: options.topRanked,
          })
        : await chunkedFullCorpusSearch({
            ...shared,
            corpusChunkSize: this.corpusChunkSize,
            searchKOffset: 1,
          });
    this.taskCorpus = null;
    const results: RetrievalOutputType = new Map(
      [...queryIdxToId.values()].map((query) => [query, new Map()]),
    );
    for (const [query, heap] of heaps)
      for (const [score, id] of heap) results.get(query)?.set(id, score);
    return results;
  }
}

// _select_loader_rows: a dataloader over the rows at the indices, repeats
// kept, in batches of batchSize. The rows are batched only now, so a column
// with a missing value stops only the batches that hold the rows it selects.
export function selectLoaderRows(
  rows: readonly PreparedRow[],
  indices: readonly number[],
  batchSize: number,
): BatchedInput[] {
  return collate(
    indices.map((index) => {
      const row = rows[index];
      if (row === undefined)
        throw new Error(
          `IndexError: Index ${index} out of range for dataset of size ${rows.length}.`,
        );
      return row;
    }),
    batchSize,
  );
}

// A cross-encoder as a search model for reranking: it keeps the corpus at
// index time, and scores each candidate of each query at search time. It
// gives every candidate a score, so topK has no effect.
export class SearchCrossEncoderWrapper implements SearchProtocol {
  readonly model: CrossEncoderProtocol;
  readonly mtebModelMeta: ModelMeta;
  taskCorpus: CorpusDatasetType | null = null;

  constructor(model: CrossEncoderProtocol) {
    this.model = model;
    this.mtebModelMeta = model.mtebModelMeta;
  }

  async index(
    corpus: CorpusDatasetType,
    _options: IndexOptions,
  ): Promise<void> {
    this.taskCorpus = corpus;
  }

  async search(
    queries: QueryDatasetType,
    options: SearchOptions,
  ): Promise<RetrievalOutputType> {
    const topRanked = options.topRanked;
    if (topRanked === undefined || topRanked === null)
      throw new Error(
        'CrossEncoder search requires top_ranked documents for reranking.',
      );
    const corpus = this.taskCorpus;
    if (corpus === null)
      throw new Error('Corpus must be indexed before searching.');
    const docIdToIdx = new Map(
      corpus.map((document, index) => [document.id, index]),
    );
    const queryIndices: number[] = [];
    const docIndices: number[] = [];
    const docPairsIds: [query: string, document: string][] = [];
    for (const [queryIndex, { id: query }] of queries.entries()) {
      const candidates = topRanked.get(query);
      // MTEB logs a warning for a query without candidates; logging is not
      // ported.
      if (candidates === undefined) continue;
      for (const document of candidates) {
        const docIndex = docIdToIdx.get(document);
        if (docIndex === undefined) throw new Error(`KeyError: '${document}'`);
        docPairsIds.push([query, document]);
        queryIndices.push(queryIndex);
        docIndices.push(docIndex);
      }
    }
    const batchSize = options.encodeKwargs.batchSize ?? 32;
    // The whole datasets are prepared before the pairs select their rows, as
    // in MTEB.
    const location = {
      taskMetadata: options.taskMetadata,
      hfSplit: options.hfSplit,
      hfSubset: options.hfSubset,
    };
    const queriesLoader = selectLoaderRows(
      createDataloaderDataset(queries, {
        taskMetadata: options.taskMetadata,
        promptType: 'query',
      }),
      queryIndices,
      batchSize,
    );
    const corpusLoader = selectLoaderRows(
      createDataloaderDataset(corpus, {
        taskMetadata: options.taskMetadata,
        promptType: 'document',
      }),
      docIndices,
      batchSize,
    );
    // As in MTEB, the model gets no prompt type.
    const predictions = await this.model.predict(queriesLoader, corpusLoader, {
      ...options.encodeKwargs,
      ...location,
    });
    const mismatch = zipStrictMismatch([
      docPairsIds.length,
      predictions.length,
    ]);
    if (mismatch !== null) throw new Error(mismatch);
    const results: RetrievalOutputType = new Map(
      queries.map(({ id }) => [id, new Map()]),
    );
    for (const [index, [query, document]] of docPairsIds.entries())
      results.get(query)?.set(document, predictions[index] ?? Number.NaN);
    return results;
  }
}
