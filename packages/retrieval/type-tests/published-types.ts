// A consumer of the built package: it imports the entry point that the
// `types` condition of package.json names, so TypeScript reads the
// declarations in dist, as an installed copy reads them.
// src/published-types.test.ts compiles this file and expects, on each line
// marked `// TS<code>`, exactly that error, and no other error.
import {
  Collapse,
  ContextWindow,
  EmbeddingRerankRetriever,
  type Filter,
  type Fusion,
  FusionRetriever,
  LongContextReorder,
  type Metadata,
  MultiQueryRetriever,
  type Passage,
  type PassageStore,
  PostprocessingRetriever,
  type Postprocessor,
  type QueryBundle,
  type QueryType,
  RankFusion,
  type RankedDoc,
  RerankRetriever,
  type RetrievalResult,
  type Retriever,
  ScoreFusion,
  type ScoredPassage,
  type StoredPassage,
  minMax,
  sum,
} from '../dist/index.js';
import {
  PgvectorEmbeddingRetriever,
  PgvectorKeywordRetriever,
  type PostgresMatching,
  PostgresPassageStore,
  type PostgresSession,
} from '../dist/postgres.js';
import {
  SqliteBM25Retriever,
  SqliteEmbeddingRetriever,
  type SqliteMatching,
  SqlitePassageStore,
} from '../dist/sqlite.js';
import {
  SqlServerEmbeddingRetriever,
  SqlServerKeywordRetriever,
  type SqlServerMatching,
  SqlServerPassageStore,
  type SqlServerSession,
} from '../dist/sqlserver.js';

type IssueQueryBundle = QueryBundle & { readonly jql: string };

declare const plain: Retriever;
declare const issues: Retriever<IssueQueryBundle>;

const federation = new FusionRetriever({
  retrievers: { plain: { retriever: plain }, issues: { retriever: issues } },
});
const postprocessed = new PostprocessingRetriever({
  retriever: issues,
  postprocessors: [],
});

// A composite of host retrievers keeps its host query type.
export const fused: FusionRetriever<IssueQueryBundle> = federation;
export const kept: PostprocessingRetriever<IssueQueryBundle> = postprocessed;
// A composite of plain retrievers serves a host query too (contravariance).
export const served: FusionRetriever<IssueQueryBundle> = new FusionRetriever({
  retrievers: { plain: { retriever: plain } },
});

// A host composite does not widen to a plain one: a string has no jql.
export const widened: FusionRetriever = federation; // TS2322
export const widenedPostprocessing: PostprocessingRetriever = postprocessed; // TS2322
export const widenedPort: Retriever = federation; // TS2322

// The retrievers of a fusion are named, each with its weight: a record of no
// retriever and a name that holds ':', the separator of a nested failure's
// path, do not compile (ADR 0014).
export const weighted = new FusionRetriever({
  retrievers: {
    plain: { retriever: plain },
    issues: { retriever: issues, weight: 2 },
  },
});
export const noRetriever = new FusionRetriever({
  retrievers: {}, // TS2322
});
export const pathName = new FusionRetriever({
  retrievers: {
    plain: { retriever: plain },
    'labels:dailymed': { retriever: plain }, // TS2322
  },
});
// A record typed by string compiles, and the constructor checks it.
declare const dynamic: Readonly<
  Record<string, { readonly retriever: Retriever; readonly weight?: number }>
>;
export const fromConfig = new FusionRetriever({ retrievers: dynamic });

// The passage type, the second parameter of the port (ADR 0015).
type Label = { readonly setid: string; readonly year: number };
type Year<Y> = { readonly year: Y };
type Of<P extends Passage> = Promise<RetrievalResult<P>>;
declare const engine: Retriever<string, StoredPassage<Label>>;
declare const live: Retriever<string, Passage<Label>>;
declare const pubmed: Retriever<
  string,
  StoredPassage<{ readonly pmid: string }>
>;
declare const store: PassageStore;

// A live source gives a passage without source, seq, start and end, and a
// passage in an order only has no score.
export const web: Retriever<string, Passage<{ readonly url: string }>> = {
  retrieve: async () => ({
    passages: [
      { passage: { id: 'u1', text: 'a result', metadata: { url: 'u' } } },
    ],
    failures: new Map(),
  }),
};

// An engine is a retriever of plain passages: its filter takes more fields,
// and it gives more. A live source is not a retriever of stored passages.
export const widenedPassage: Retriever<string, Passage<Label>> = engine;
export const narrowed: Retriever<string, StoredPassage<Label>> = live; // TS2322
// A filter on year: number could reach a retriever whose year is 2026, and
// so could the filter of a composite.
declare const narrowYear: Retriever<string, Passage<Year<2026>>>;
export const wideYear: Retriever<string, Passage<Year<number>>> = narrowYear; // TS2322
type YearFusion<Y> = FusionRetriever<string, Passage<Year<Y>>>;
declare const narrowFusion: YearFusion<2026>;
export const wideFusion: YearFusion<number> = narrowFusion; // TS2322

// The metadata is typed.
export const typo = async (): Promise<unknown> =>
  (await engine.retrieve('q')).passages[0]?.passage.metadata.setId; // TS2551

// The filter is typed by the passage: its fields and its values. The default
// metadata keeps any metadata.<column> with any value.
type LabelFilter = Filter<StoredPassage<Label>>;
export const filters: LabelFilter[] = [
  { field: 'metadata.year', operator: '>=', value: 2020 },
  { field: 'source', operator: 'in', value: ['a', 'b'] },
  { field: 'metadata.setId', operator: '==', value: 'x' }, // TS2820
  { field: 'metadata.year', operator: '>', value: 'last year' }, // TS2322
];
export const liveFilter: Filter<Passage<Label>> = {
  field: 'seq', // TS2322
  operator: '==',
  value: 0,
};
export const bag: Filter = { field: 'metadata.x', operator: '==', value: 1 };

// ContextWindow needs stored passages: it goes over an engine and over a
// fusion of engines, and not over a live source.
const engines = new FusionRetriever({
  retrievers: { labels: { retriever: engine }, more: { retriever: engine } },
});
export const fusedEngines: Of<StoredPassage<Label>> = engines.retrieve('q');
export const overEngines = new PostprocessingRetriever({
  retriever: engines,
  postprocessors: [new LongContextReorder(), new ContextWindow({ store })],
});
export const overLive = new PostprocessingRetriever({
  retriever: web,
  postprocessors: [new ContextWindow({ store })], // TS2322
});
export const reorderLive = new PostprocessingRetriever({
  retriever: web,
  postprocessors: [new LongContextReorder()],
});

// A fusion of a live source and an engine gives their common type,
// Passage<Label>, so it takes no ContextWindow.
const mixed = new FusionRetriever({
  retrievers: { live: { retriever: live }, engine: { retriever: engine } },
});
export const common: Of<Passage<Label>> = mixed.retrieve('q');
export const stored: Of<StoredPassage<Label>> = mixed.retrieve('q'); // TS2322
export const mixedWindow = new PostprocessingRetriever({
  retriever: mixed,
  postprocessors: [new ContextWindow({ store })], // TS2322
});
// Two metadata types fuse only with a type argument that names their union.
export const two = new FusionRetriever({
  retrievers: { engine: { retriever: engine }, pubmed: { retriever: pubmed } }, // TS2322
});
type Both = StoredPassage<Label> | StoredPassage<{ readonly pmid: string }>;
export const both = new FusionRetriever<string, Both>({
  retrievers: { engine: { retriever: engine }, pubmed: { retriever: pubmed } },
});

// The ports are generic in their parameter, not in their method (the island
// rule): P comes from the retriever, and each built-in takes it with no type
// argument, as its method is generic.
declare const model: ConstructorParameters<typeof RerankRetriever>[0]['model'];
export const reranked: Of<StoredPassage<Label>> = new PostprocessingRetriever({
  retriever: new RerankRetriever({ retriever: engine, model }),
  postprocessors: [new ContextWindow({ store })],
}).retrieve('q');
declare const embeddingModel: ConstructorParameters<
  typeof EmbeddingRerankRetriever
>[0]['model'];
export const embeddingReranked: Of<StoredPassage<Label>> =
  new PostprocessingRetriever({
    retriever: new EmbeddingRerankRetriever({
      retriever: engine,
      model: embeddingModel,
    }),
    postprocessors: [new ContextWindow({ store })],
  }).retrieve('q');
export const ranked: Of<StoredPassage<Label>> = new FusionRetriever({
  retrievers: { labels: { retriever: engine }, more: { retriever: engine } },
  fusion: new RankFusion(),
}).retrieve('q');
// A host writes a postprocessor or a fusion for its own passage type, and
// gives back passages of that type with no assertion.
const pinned: StoredPassage<Label> = {
  id: 'p1',
  text: 'a pinned label',
  metadata: { setid: 's', year: 2026 },
  source: 'labels',
  seq: 0,
  start: 0,
  end: 14,
};
const pin: Postprocessor<StoredPassage<Label>> = {
  postprocess: async (passages) => [{ passage: pinned }, ...passages],
};
const firstList: Fusion<RankedDoc> = {
  fuse: (inputs) =>
    (inputs[0]?.docs ?? []).map(({ id }, rank) => ({
      id,
      score: 1 / (rank + 1),
    })),
};
// A pin adds a passage without a score, so it goes over a list of order
// only: a fusion gives scores, and the host types it as a retriever of order
// first (#5400).
const hostFusion: Retriever<string, StoredPassage<Label>> = new FusionRetriever(
  {
    retrievers: { labels: { retriever: engine }, more: { retriever: engine } },
    fusion: firstList,
  },
);
export const hosted: Of<StoredPassage<Label>> = new PostprocessingRetriever({
  retriever: hostFusion,
  postprocessors: [pin, new LongContextReorder()],
}).retrieve('q');

// A score fusion reads scores, so each retriever under it gives scored
// passages: a live source of order only does not compile under a
// ScoreFusion, in a FusionRetriever and a MultiQueryRetriever, nor do its
// docs in the fusion itself (#5400). Engines, and a fusion, which gives
// fused scores, compile under it. Both composites give scored passages.
declare const languageModel: ConstructorParameters<
  typeof MultiQueryRetriever
>[0]['model'];
declare const scoredEngine: Retriever<
  string,
  StoredPassage<Label>,
  ScoredPassage<StoredPassage<Label>>
>;
declare const liveSearch: Retriever<QueryType, Passage<Label>>;
const byScore = () =>
  new ScoreFusion({ normalizer: minMax(), combination: sum() });
export const scoredEngines: Promise<
  RetrievalResult<StoredPassage<Label>, ScoredPassage<StoredPassage<Label>>>
> = new FusionRetriever({
  retrievers: {
    labels: { retriever: scoredEngine },
    more: { retriever: scoredEngine },
  },
  fusion: byScore(),
}).retrieve('q');
export const scoredFusion = new FusionRetriever({
  retrievers: {
    mixed: { retriever: mixed },
    engine: { retriever: scoredEngine },
  },
  fusion: byScore(),
});
export const scoredLive = new FusionRetriever({
  retrievers: {
    live: { retriever: live }, // TS2322
    engine: { retriever: scoredEngine },
  },
  fusion: byScore(),
});
export const multiScored: Promise<
  RetrievalResult<Passage<Label>, ScoredPassage<Passage<Label>>>
> = new MultiQueryRetriever({
  retriever: liveSearch,
  model: languageModel,
}).retrieve('q');
export const multiScoredLive = new MultiQueryRetriever({
  retriever: liveSearch, // TS2322
  model: languageModel,
  fusion: byScore(),
});
// A PostprocessingRetriever gives the kind of its retriever, and each of its
// postprocessors takes that kind (#5400). The built-ins keep the kind they
// get. A host postprocessor of order only, such as the pin, does not go over
// a scored retriever, nor one that reads scores over a list of order only.
// A RerankRetriever gives scores over a list of order only, so it goes under
// a score fusion.
const cutoff: Postprocessor<
  StoredPassage<Label>,
  ScoredPassage<StoredPassage<Label>>
> = {
  postprocess: async (passages) => passages.filter(({ score }) => score >= 0.5),
};
type ScoredLabels = Promise<
  RetrievalResult<StoredPassage<Label>, ScoredPassage<StoredPassage<Label>>>
>;
export const keptScores: ScoredLabels = new PostprocessingRetriever({
  retriever: scoredEngine,
  postprocessors: [
    cutoff,
    new Collapse(),
    new LongContextReorder(),
    new ContextWindow({ store }),
  ],
}).retrieve('q');
const orderOnly = new PostprocessingRetriever({
  retriever: engine,
  postprocessors: [new Collapse(), new LongContextReorder()],
});
export const keptOrder: Of<StoredPassage<Label>> = orderOnly.retrieve('q');
export const notScored: ScoredLabels = orderOnly.retrieve('q'); // TS2322
export const pinnedScores = new PostprocessingRetriever({
  retriever: scoredEngine,
  postprocessors: [pin], // TS2322
});
export const cutOrder = new PostprocessingRetriever({
  retriever: engine,
  postprocessors: [cutoff], // TS2322
});
export const rerankedLive = new FusionRetriever({
  retrievers: {
    live: { retriever: new RerankRetriever({ retriever: live, model }) },
    engine: { retriever: scoredEngine },
  },
  fusion: byScore(),
});
export const embeddingRerankedLive = new FusionRetriever({
  retrievers: {
    live: {
      retriever: new EmbeddingRerankRetriever({
        retriever: live,
        model: embeddingModel,
      }),
    },
    engine: { retriever: scoredEngine },
  },
  fusion: byScore(),
});
export const unscoredDocs = byScore().fuse([
  { name: 'web', weight: 1, docs: [{ id: 'u1' }] }, // TS2322
]);

// An engine is typed by the metadata that its store reads from each row: the
// store's required `metadata` gives M, and every retriever over the store
// gives StoredPassage<M> (ADR 0015).
const label = (columns: Metadata): Label => {
  const { setid, year } = columns;
  if (typeof setid !== 'string' || typeof year !== 'number') {
    throw new TypeError('A label has a setid and a year');
  }
  return { setid, year };
};
type Article = { readonly pmid: string };
const article = (columns: Metadata): Article => {
  const { pmid } = columns;
  if (typeof pmid !== 'string') throw new TypeError('An article has a pmid');
  return { pmid };
};
type SqliteOptions = ConstructorParameters<typeof SqlitePassageStore>[0];
declare const database: SqliteOptions['database'];
declare const session: PostgresSession;
declare const embeddings: ConstructorParameters<
  typeof SqliteEmbeddingRetriever
>[0]['model'];
const labels = new SqlitePassageStore({
  database,
  passages: 'labels',
  metadata: label,
});
const keyword = new SqliteBM25Retriever({ store: labels, index: 'labels_fts' });
const embedding = new SqliteEmbeddingRetriever({
  store: labels,
  vectors: 'label_vectors',
  model: embeddings,
});
const articles = new PostgresPassageStore({
  session,
  passages: 'articles',
  metadata: article,
});
const articleKeyword = new PgvectorKeywordRetriever({
  store: articles,
  index: { column: 'search' },
});
export const typedStore: Promise<ReadonlyMap<string, StoredPassage<Label>>> =
  labels.get(['p1']);
export const typedKeyword: Of<StoredPassage<Label>> = keyword.retrieve('q');
// A live source beside an engine class of one metadata type fuses to their
// common passage type, in either order, as an array of both did.
export const liveFirst: Of<Passage<Label>> = new FusionRetriever({
  retrievers: { live: { retriever: live }, keyword: { retriever: keyword } },
}).retrieve('q');
export const engineFirst: Of<Passage<Label>> = new FusionRetriever({
  retrievers: { keyword: { retriever: keyword }, live: { retriever: live } },
}).retrieve('q');
export const typedMany: Promise<RetrievalResult<StoredPassage<Label>>[]> =
  embedding.retrieveMany(['q']);
export const typedArticles: Of<StoredPassage<Article>> =
  new PgvectorEmbeddingRetriever({
    store: articles,
    vectors: 'article_vectors',
    model: embeddings,
  }).retrieve('q');
// The store's metadata is required: the bag is `(columns) => columns`.
export const untyped = new SqlitePassageStore({ database, passages: 'x' }); // TS2741
export const bagged: Of<StoredPassage> = new SqliteBM25Retriever({
  store: new SqlitePassageStore({
    database,
    passages: 'x',
    metadata: (columns) => columns,
  }),
  index: 'x_fts',
}).retrieve('q', {
  filter: { field: 'metadata.any', operator: '==', value: 1 },
});

// The filter of an engine is checked against its M: a field that M lacks and
// a value of the wrong type do not compile.
export const lacking = keyword.retrieve('q', {
  filter: { field: 'metadata.setId', operator: '==', value: 's' }, // TS2820
});
export const wrongValue = embedding.retrieve('q', {
  filter: { field: 'metadata.year', operator: '>=', value: '2020' }, // TS2322
});
export const articleFilter = articleKeyword.retrieve('q', {
  filter: { field: 'metadata.pmid', operator: 'in', value: ['1', '2'] },
});
// An engine of a narrower metadata value is not one of a wider value.
declare const year2026: SqliteBM25Retriever<Year<2026>>;
export const anyYear: SqliteBM25Retriever<Year<number>> = year2026; // TS2322

// A fusion of two engines of one M keeps StoredPassage<M>, so ContextWindow
// follows it. Two engines of different M fuse only when the type argument
// names their union, as the paper wants: no inferred type covers both, and
// the union is not the intersection.
const sameM = new FusionRetriever({
  retrievers: {
    keyword: { retriever: keyword },
    embedding: { retriever: embedding },
  },
});
export const sameMetadata: Of<StoredPassage<Label>> = sameM.retrieve('q');
export const sameWindow = new PostprocessingRetriever({
  retriever: sameM,
  postprocessors: [new ContextWindow({ store: labels })],
});
export const twoM = new FusionRetriever({
  retrievers: {
    keyword: { retriever: keyword },
    articleKeyword: { retriever: articleKeyword }, // TS2322
  },
});
type Either = StoredPassage<Label> | StoredPassage<Article>;
const eitherM = new FusionRetriever<string, Either>({
  retrievers: {
    keyword: { retriever: keyword },
    articleKeyword: { retriever: articleKeyword },
  },
});
export const either: Of<Either> = eitherM.retrieve('q');
type LabelAndArticle = StoredPassage<Label & Article>;
export const intersection: Of<LabelAndArticle> = eitherM.retrieve('q'); // TS2322
// ContextWindow takes the M of its store: the store of articles widens no
// label, and the store of labels widens no article of a fusion of both.
export const otherStore = new PostprocessingRetriever({
  retriever: keyword,
  postprocessors: [new ContextWindow({ store: articles })], // TS2322
});
export const oneStoreOfTwo = new PostprocessingRetriever({
  retriever: eitherM,
  postprocessors: [new ContextWindow({ store: labels })], // TS2322
});

// A Collapse names a field of its passage type: any metadata key of the
// default StoredPassage, the keys of M with a type argument, and a live
// passage type needs the field, since it has no source.
export const bySource = new Collapse();
export const byLabel = new Collapse<StoredPassage<Label>>({
  field: 'metadata.setid',
});
export const byTypo = new Collapse<StoredPassage<Label>>({
  field: 'metadata.setId', // TS2820
});
export const liveDefault = new Collapse<Passage<Label>>(); // TS2554
export const liveSource = new Collapse<Passage<Label>>({ field: 'source' }); // TS2322
export const liveField = new Collapse<Passage<Label>>({
  field: 'metadata.year',
});
export const collapsed: Of<StoredPassage<Label>> = new PostprocessingRetriever({
  retriever: keyword,
  postprocessors: [
    new Collapse<StoredPassage<Label>>({ field: 'metadata.year', size: 2 }),
  ],
}).retrieve('q');
// With no type argument, the passages of the retriever check the field: a
// key that M lacks does not compile over the Label engine, while a key of M
// and a stored field do; a bag engine takes any key. A live retriever takes
// no default source: its Collapse names its passage type.
export const untypedField: Of<StoredPassage<Label>> =
  new PostprocessingRetriever({
    retriever: keyword,
    postprocessors: [
      new Collapse({ field: 'metadata.year' }),
      new Collapse({ field: 'seq' }),
      new Collapse({ field: 'source' }),
      new Collapse(),
    ],
  }).retrieve('q');
export const untypedLacking = new PostprocessingRetriever({
  retriever: keyword,
  postprocessors: [new Collapse({ field: 'metadata.setId' })], // TS2322
});
export const bagField: Of<StoredPassage> = new PostprocessingRetriever({
  retriever: new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'x',
      metadata: (columns) => columns,
    }),
    index: 'x_fts',
  }),
  postprocessors: [new Collapse({ field: 'metadata.anything' })],
}).retrieve('q');
export const liveNoSource = new PostprocessingRetriever({
  retriever: live,
  postprocessors: [new Collapse()], // TS2322
});
export const liveYear: Of<Passage<Label>> = new PostprocessingRetriever({
  retriever: live,
  postprocessors: [new Collapse<Passage<Label>>({ field: 'metadata.year' })],
}).retrieve('q');
declare const scoredLabels: Parameters<
  Postprocessor<StoredPassage<Label>>['postprocess']
>[0];
export const direct = new Collapse({ field: 'metadata.setid' }).postprocess(
  scoredLabels,
);
export const directLacking = new Collapse({
  field: 'metadata.nope',
}).postprocess(scoredLabels); // TS2345
// A Collapse declares no `implements`, so these prove it is a Postprocessor
// of a typed and of a bag passage type.
export const typedPort: Postprocessor<StoredPassage<Label>> = new Collapse({
  field: 'metadata.year',
});
export const typedPortOfP: Postprocessor<StoredPassage<Label>> = new Collapse<
  StoredPassage<Label>
>({ field: 'metadata.setid' });
export const bagPort: Postprocessor<StoredPassage> = new Collapse({
  field: 'metadata.anything',
});
export const livePort: Postprocessor<Passage<Label>> = new Collapse<
  Passage<Label>
>({ field: 'metadata.year' });

// Every async port takes `signal`, the name of the DOM, fetch, Node and
// every other zukhruf package; the old `abortSignal` is gone, with no alias
// (ADR 0017).
declare const signal: AbortSignal;
export const retrieved = plain.retrieve('q', { signal });
export const oldRetrieve = plain.retrieve('q', { abortSignal: signal }); // TS2353
declare const postprocessor: Postprocessor;
export const signalled = postprocessor.postprocess([], 'q', { signal });
export const oldPostprocess = postprocessor.postprocess([], 'q', {
  abortSignal: signal, // TS2353
});
export const got = store.get(['a'], { signal });
export const oldGet = store.get(['a'], { abortSignal: signal }); // TS2353
export const window = store.neighbours({
  source: 's',
  seq: 0,
  windowSize: 1,
  signal,
});
export const oldWindow = store.neighbours({
  source: 's',
  seq: 0,
  windowSize: 1,
  abortSignal: signal, // TS2353
});
// A host session reads the signal of each query.
export const cancelling: PostgresSession = {
  query: async (_sql, _parameters, options) => {
    options?.signal?.throwIfAborted();
    return [];
  },
};
export const oldSession: PostgresSession = {
  query: async (_sql, _parameters, options) => {
    options?.abortSignal?.throwIfAborted(); // TS2339
    return [];
  },
};

// Each keyword retriever takes the matching of its own engine, a
// discriminated union with no shared form (ADR 0018). The old `operator` is
// gone, with no alias; another engine's matching and a contradictory
// combination do not compile.
declare const sqlServerSession: SqlServerSession;
const documents = new SqlServerPassageStore({
  session: sqlServerSession,
  passages: 'documents',
  metadata: (columns) => columns,
});
const anyWord: SqliteMatching = { operator: 'OR' };
const commonTerms: SqliteMatching = { operator: 'OR', cutoffFrequency: 20_000 };
const allLexemes: PostgresMatching = { strategy: 'all' };
const dropMostFrequent: PostgresMatching = {
  strategy: 'frequency',
  dropTokensThreshold: 10,
};
const containsAny: SqlServerMatching = {
  predicate: 'CONTAINS',
  operator: 'OR',
};
export const sqliteMatching = new SqliteBM25Retriever({
  store: labels,
  index: 'labels_fts',
  matching: anyWord,
});
export const sqliteCommonTerms = new SqliteBM25Retriever({
  store: labels,
  index: 'labels_fts',
  matching: commonTerms,
});
export const postgresMatching = new PgvectorKeywordRetriever({
  store: articles,
  index: { column: 'search' },
  matching: allLexemes,
});
export const postgresFrequency = new PgvectorKeywordRetriever({
  store: articles,
  index: { column: 'search' },
  matching: dropMostFrequent,
});
export const sqlServerMatching = new SqlServerKeywordRetriever({
  store: documents,
  index: { table: 'documents' },
  matching: containsAny,
});
export const sqliteOperator = new SqliteBM25Retriever({
  store: labels,
  index: 'labels_fts',
  operator: 'OR', // TS2353
});
export const postgresOperator = new PgvectorKeywordRetriever({
  store: articles,
  index: { column: 'search' },
  operator: 'AND', // TS2353
});
export const sqlServerOperator = new SqlServerKeywordRetriever({
  store: documents,
  index: { table: 'documents' },
  operator: 'OR', // TS2353
});
export const sqliteGivenPostgres = new SqliteBM25Retriever({
  store: labels,
  index: 'labels_fts',
  matching: allLexemes, // TS2322
});
export const postgresGivenSqlServer = new PgvectorKeywordRetriever({
  store: articles,
  index: { column: 'search' },
  matching: containsAny, // TS2322
});
export const sqlServerGivenSqlite = new SqlServerKeywordRetriever({
  store: documents,
  index: { table: 'documents' },
  matching: anyWord, // TS2322
});
export const andWithCutoff: SqliteMatching = {
  operator: 'AND',
  cutoffFrequency: 20_000, // TS2353
};
export const allWithThreshold: PostgresMatching = {
  strategy: 'all',
  dropTokensThreshold: 10, // TS2353
};
export const postgresOr: PostgresMatching = { strategy: 'all', operator: 'OR' }; // TS2353
export const frequencyWithCutoff: PostgresMatching = {
  strategy: 'frequency',
  cutoffFrequency: 20_000, // TS2353
};
// CONTAINS takes its Boolean operator.
export const contains: SqlServerMatching = { predicate: 'CONTAINS' }; // TS2322
// FREETEXT has no operator.
export const freeTextWithOperator: SqlServerMatching = {
  predicate: 'FREETEXT',
  operator: 'AND', // TS2353
};

// A score threshold is an option of the object that knows the scale of its
// scores: each embedding retriever, with the cosine similarity, and
// RerankRetriever, with the score of its model. A call does not take one, so a fusion never
// gives it to a keyword retriever (ADR 0019).
export const thresholds = [
  new SqliteEmbeddingRetriever({
    store: labels,
    vectors: 'label_vectors',
    model: embeddings,
    scoreThreshold: 0.5,
  }),
  new PgvectorEmbeddingRetriever({
    store: articles,
    vectors: 'article_vectors',
    model: embeddings,
    scoreThreshold: 0.5,
  }),
  new SqlServerEmbeddingRetriever({
    store: documents,
    vectors: 'document_vectors',
    model: embeddings,
    scoreThreshold: 0.5,
  }),
  new RerankRetriever({ retriever: plain, model, scoreThreshold: 0.5 }),
  new EmbeddingRerankRetriever({
    retriever: plain,
    model: embeddingModel,
    scoreThreshold: 0.5,
  }),
];
export const perCall = embedding.retrieve('q', {
  scoreThreshold: 0.5, // TS2353
});
