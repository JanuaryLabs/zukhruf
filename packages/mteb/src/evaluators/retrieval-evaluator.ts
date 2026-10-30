import type { TaskMetadata } from '../abstasks/task-metadata.ts';
import type { SearchProtocol } from '../models/models-protocols.ts';
import { SearchEncoderWrapper } from '../models/search-wrappers.ts';
import { type TimingStack, monotonic } from '../timing.ts';
import type {
  CorpusDatasetType,
  EncodeKwargs,
  QueryDatasetType,
  RelevantDocumentsType,
  RetrievalOutputType,
  TopRankedDocumentsType,
} from '../types/encoder-io.ts';
import type { RetrievalEvaluationResult } from '../types/result.ts';
import { Evaluator } from './evaluator.ts';
import { calculateRetrievalScores } from './retrieval-metrics.ts';

// mteb/_evaluators/retrieval_evaluator.py. Python's __call__ is search().
export class RetrievalEvaluator extends Evaluator {
  readonly corpus: CorpusDatasetType;
  readonly queries: QueryDatasetType;
  readonly topRanked: TopRankedDocumentsType | null;
  readonly taskMetadata: TaskMetadata;
  readonly hfSplit: string;
  readonly hfSubset: string;
  readonly qid: string | null;
  readonly topK: number;
  readonly timer: TimingStack;

  constructor(
    corpus: CorpusDatasetType,
    queries: QueryDatasetType,
    options: {
      readonly taskMetadata: TaskMetadata;
      readonly hfSplit: string;
      readonly hfSubset: string;
      readonly topK: number;
      readonly topRanked?: TopRankedDocumentsType | null;
      readonly qid?: string | null;
      readonly timer: TimingStack;
      readonly seed?: number;
    },
  ) {
    super(options);
    this.corpus = corpus;
    this.queries = queries;
    this.topRanked = options.topRanked ?? null;
    this.taskMetadata = options.taskMetadata;
    this.hfSplit = options.hfSplit;
    this.hfSubset = options.hfSubset;
    this.qid = options.qid ?? null;
    this.topK = options.topK;
    this.timer = options.timer;
  }

  // Indexes the corpus and searches it for the queries.
  async search(
    searchModel: SearchProtocol,
    encodeKwargs: EncodeKwargs,
  ): Promise<RetrievalOutputType> {
    const location = {
      taskMetadata: this.taskMetadata,
      hfSplit: this.hfSplit,
      hfSubset: this.hfSubset,
    };
    const start = monotonic();
    await searchModel.index(this.corpus, { ...location, encodeKwargs });
    const end = monotonic();
    // A SearchEncoderWrapper without an index backend encodes the corpus
    // during the search, so indexing is not "Encoding corpus".
    const encodesCorpusDuringSearch =
      searchModel instanceof SearchEncoderWrapper;
    if (!encodesCorpusDuringSearch)
      this.timer.addPhase('Encoding corpus', {
        start,
        end,
        split: this.hfSplit,
        subset: this.hfSubset,
      });
    const options = {
      ...location,
      topK: this.topK,
      encodeKwargs,
      topRanked: this.topRanked,
    };
    // The wrapper records its own phases.
    if (searchModel instanceof SearchEncoderWrapper)
      return searchModel.search(this.queries, {
        ...options,
        timer: this.timer,
      });
    using _ = this.timer.phase(
      encodesCorpusDuringSearch
        ? 'Encoding queries and documents'
        : 'Encoding queries',
      { split: this.hfSplit, subset: this.hfSubset },
    );
    return await searchModel.search(this.queries, options);
  }

  // Scores the results against the qrels. ignoreIdenticalIds drops each
  // document whose id is the id of its query.
  evaluate(
    qrels: RelevantDocumentsType,
    results: RetrievalOutputType,
    kValues: readonly number[],
    ignoreIdenticalIds = false,
    skipFirstResult = false,
  ): RetrievalEvaluationResult {
    if (ignoreIdenticalIds)
      for (const [query, scores] of results) scores.delete(query);
    return calculateRetrievalScores(results, qrels, kValues, skipFirstResult);
  }
}
