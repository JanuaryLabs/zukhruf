# The owner's sizing caps the jobs of its computer

Status: Proposed 2026-11-16 for Ezz's review (backlog #3527). Built in `PoolWorkers` (2026-11-16).

The Neural Engine limits the Vision jobs of a computer. Two programs together read 51 to 75 images a second on 2026-11-02, and 12 workers on one computer gave E5RT failures (context-compiler `docs/vision-*.md`). Something must cap the jobs that run at once. Two places can: the pool's own sizing, or a count in the shared store (pg-boss `groupConcurrency`, a cap for each group across all computers).

## Decision

From map ticket 06, resolved with Ezz on 2026-11-03:

- **One computer: the owner's sizing is the cap.** The owner runs every job of its computer through one pool, so its sizing (`Fixed`, `Resources`, `HillClimbing`, `Gradient`) caps the jobs that run at once, one job for each worker. A sizing that learns ([ADR 0007](./0007-a-sizing-that-learns-keeps-learning-in-steps-both-ways-and-pauses-between-steps-that-change-nothing.md)) then measures every job of the computer. The problem of 2026-11-02, a pool that does not yield because it measures only its own jobs, cannot occur. (Ezz: "Yes, the owner's sizing".)
- **Many computers: each owner caps its own computer** with its own sizing. The store keeps no cap across computers. Shared stores cap for each queue or group across all nodes. A cap for one computer lives in the one program on that computer. (Ezz: "Yes, per computer".)
- The store keeps no count of running jobs.
- **`Computer` keeps its meaning** ([ADR 0009](./0009-a-sizing-reads-the-capacity-from-the-computer-that-the-caller-gives.md)). The owner reads the capacity of the whole computer. A host gives a part of the computer only when different pools share it, for example Vision and transcription on one Mac. (Ezz: "Yes, unchanged".)
- **A new owner starts fresh**, from the first size of its sizing. The store hands no learned size over. (Ezz: "Start fresh".)
- **No two owners on one computer.** The claim of the election is a kernel file lock, so no second owner wins while the first one's process lives, also when that process is frozen ([ADR 0024](./0024-a-hung-owner-is-ended-by-the-election-and-its-late-acts-are-fenced.md)). A `Coprocess` helper exits when its stdin closes, so the workers of a dead owner end with it.

## Consequences

- The owner takes only as many jobs as its sizing runs ([ADR 0017](./0017-the-owner-asks-then-takes-as-many-jobs-as-it-has-free-workers.md)).
- The owner caps only the jobs of its own pool. The helpers of another pool or another program on the same computer still share the Neural Engine (#3868).
- A cap across all computers, for example the rate limit of a paid API, is out of scope.
