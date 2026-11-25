// A consumer of the built package: it imports the entry point that the
// `types` condition of package.json names, so TypeScript reads the
// declarations in dist, as an installed copy reads them.
// src/published-types.test.ts compiles this file and expects, on each line
// marked `// TS<code>`, exactly that error, and no other error.
import {
  ContextWindow,
  type Filter,
  type Fusion,
  FusionRetriever,
  type Passage,
  type PassageStore,
  PostprocessingRetriever,
  type Postprocessor,
  type QueryBundle,
  Rerank,
  type RetrievalResult,
  type Retriever,
  SimilarityCutoff,
  type StoredPassage,
  reciprocalRankFusion,
} from '../dist/index.js';

type IssueQueryBundle = QueryBundle & { readonly jql: string };

declare const plain: Retriever;
declare const issues: Retriever<IssueQueryBundle>;

const federation = new FusionRetriever({ retrievers: [plain, issues] });
const postprocessed = new PostprocessingRetriever({
  retriever: issues,
  postprocessors: [],
});

// A composite of host retrievers keeps its host query type.
export const fused: FusionRetriever<IssueQueryBundle> = federation;
export const kept: PostprocessingRetriever<IssueQueryBundle> = postprocessed;
// A composite of plain retrievers serves a host query too (contravariance).
export const served: FusionRetriever<IssueQueryBundle> = new FusionRetriever({
  retrievers: [plain],
});

// A host composite does not widen to a plain one: a string has no jql.
export const widened: FusionRetriever = federation; // TS2322
export const widenedPostprocessing: PostprocessingRetriever = postprocessed; // TS2322
export const widenedPort: Retriever = federation; // TS2322

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
const engines = new FusionRetriever({ retrievers: [engine, engine] });
export const fusedEngines: Of<StoredPassage<Label>> = engines.retrieve('q');
export const overEngines = new PostprocessingRetriever({
  retriever: engines,
  postprocessors: [
    new SimilarityCutoff({ threshold: 0.2 }),
    new ContextWindow({ store }),
  ],
});
export const overLive = new PostprocessingRetriever({
  retriever: web,
  postprocessors: [new ContextWindow({ store })], // TS2322
});
export const cutLive = new PostprocessingRetriever({
  retriever: web,
  postprocessors: [new SimilarityCutoff({ threshold: 0.2 })],
});

// A fusion of a live source and an engine gives their common type,
// Passage<Label>, so it takes no ContextWindow.
const mixed = new FusionRetriever({ retrievers: [live, engine] });
export const common: Of<Passage<Label>> = mixed.retrieve('q');
export const stored: Of<StoredPassage<Label>> = mixed.retrieve('q'); // TS2322
export const mixedWindow = new PostprocessingRetriever({
  retriever: mixed,
  postprocessors: [new ContextWindow({ store })], // TS2322
});
// Two metadata types fuse only with a type argument that names their union.
export const two = new FusionRetriever({ retrievers: [engine, pubmed] }); // TS2322
type Both = StoredPassage<Label> | StoredPassage<{ readonly pmid: string }>;
export const both = new FusionRetriever<string, Both>({
  retrievers: [engine, pubmed],
});

// The ports are generic in their parameter, not in their method (the island
// rule): P comes from the retriever, and each built-in takes it with no type
// argument, as its method is generic.
declare const model: ConstructorParameters<typeof Rerank>[0]['model'];
export const reranked: Of<StoredPassage<Label>> = new PostprocessingRetriever({
  retriever: engine,
  postprocessors: [new Rerank({ model }), new ContextWindow({ store })],
}).retrieve('q');
export const ranked: Of<StoredPassage<Label>> = new FusionRetriever({
  retrievers: [engine, engine],
  fusion: reciprocalRankFusion(),
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
const firstList: Fusion<StoredPassage<Label>> = {
  fuse: (lists) => [...(lists[0] ?? [])],
};
export const hosted: Of<StoredPassage<Label>> = new PostprocessingRetriever({
  retriever: new FusionRetriever({
    retrievers: [engine, engine],
    fusion: firstList,
  }),
  postprocessors: [pin, new SimilarityCutoff({ threshold: 0.2 })],
}).retrieve('q');
