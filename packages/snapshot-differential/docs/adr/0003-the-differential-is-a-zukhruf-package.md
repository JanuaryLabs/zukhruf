# The differential is a zukhruf package

[ADR 0001](./0001-a-vanished-key-is-judged-by-a-deletion-policy.md) kept the differential in the repository of its pipeline until a second repository needs it. No second repository uses it yet. The maintainer chose to move it now.

The differential imports only Node.js (`node:crypto` and `node:util`), and it has no concept of the pipeline. A move of a module that other modules import is a question of cohesion, and it can occur at any time ([workspace ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md), rule 3).

Before the move, the pipeline's repository had one more snapshot diff of its own. Its URL inspection streams kept a row count for each URL, and deleted each position past the new count. They now use the differential with a `Coverage` policy, which covers the URLs that a run inspected and the URLs that left the set. Thus every snapshot diff of that repository uses the package.

## Decision

The differential is `@zukhruf/snapshot-differential`, in the base layer (`std:base`). The pipeline's repository deletes its copy and depends on the published package.

## Considered Options

- **Keep the differential in the pipeline's repository until a second repository needs it.** This was the decision of ADR 0001. A change that the pipeline and the differential need together is one commit.
- **Move the differential to zukhruf now.** This option was selected.

## Consequences

- A change to the differential is a release of zukhruf and a version change in the pipeline's repository. A change that the pipeline and the differential need together is two commits in two repositories.
- zukhruf compiles with `exactOptionalPropertyTypes`. Thus `SnapshotDifferential.expiresBy` is `string | undefined`, and the option `expiresBy` accepts `undefined`, because a caller gives the optional field of its stream.
- `isTimestamp` in `src/timestamp.ts` stays a copy of the timestamp check of the pipeline, because a tiny helper stays a copy (workspace ADR 0001, rule 4). A fix to one copy is also a fix to the other.
