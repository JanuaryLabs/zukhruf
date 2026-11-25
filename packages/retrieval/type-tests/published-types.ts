// A consumer of the built package: it imports the entry point that the
// `types` condition of package.json names, so TypeScript reads the
// declarations in dist, as an installed copy reads them.
// src/published-types.test.ts compiles this file and expects, on each line
// marked `// TS<code>`, exactly that error, and no other error.
import {
  FusionRetriever,
  PostprocessingRetriever,
  type QueryBundle,
  type Retriever,
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
