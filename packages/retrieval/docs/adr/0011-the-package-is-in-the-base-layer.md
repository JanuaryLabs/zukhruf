# The package is in the base layer

Superseded in part on 2026-11-26 (#5400) for the name of the fusion that needs `std`. `distributionBasedScoreFusion` is gone; the normalizer `distributionBased()` of a `ScoreFusion` reads `std` of `@zukhruf/statistics` through `ListScores` ([ADR 0020](./0020-a-fusion-is-a-rank-fusion-or-a-score-fusion-over-ids-with-a-normalizer-for-each-list-and-a-combination.md)). The rest of the decision below stays true.

Status: accepted by Ezz on 2026-11-23 ("this is base layer").

Root ADR 0001 sorts the packages into layers by their imports: shipped code of a `std:base` package imports only `std:base` packages, and shipped domain code imports only base and coordination packages (`eslint.config.mjs`, lines 26-38). Ezz ruled on the same day that a layer follows the imports ("Imports decide: base"), and five packages moved to base (e130cccd, #5418). `@zukhruf/mteb` is base since e130cccd, and its `HybridSearch` can move onto the fusions of this package (#5400).

## Decision

- `@zukhruf/retrieval` has the tag `std:base`.
- Its shipped code imports `@zukhruf/vectors` (the SQLite distance functions), `@zukhruf/statistics`, `@zukhruf/async` and `ai` only. It imports `untilAborted` from `@zukhruf/async`, a base package, so a fan-out rejects at once when its caller aborts ([ADR 0014](./0014-a-retrieve-call-answers-with-the-retrievers-that-answered-and-names-those-that-were-unavailable.md)). It imports `mean` and `std` from `@zukhruf/statistics`. `std` is NumPy's `np.std` (`ddof` 0 by default), which `distributionBasedScoreFusion` needs. It moved into `@zukhruf/statistics` at this third place (backlog #3992), and the two copies in `@zukhruf/mteb` (`src/dependencies/numpy.ts`) and relevance-filtering (`src/statistics.ts`, `populationSd`) use it.
- The engine subpaths take a `DatabaseSync` of `node:sqlite` or a session with one `query(sql, parameters)` method, so the package imports no database driver. `SqlServerSession` takes named parameters, a `Record`, as the SQL Server store of `@zukhruf/embedding-cache` does (`packages/embedding-cache/src/sqlserver.ts`). `PostgresSession` takes positional parameters, an array.

## Considered Options

- **The domain layer.** It lost: the imports of this package are all base, so the rule of e130cccd puts it in base, and a base package such as `@zukhruf/mteb` could not import a domain package.
