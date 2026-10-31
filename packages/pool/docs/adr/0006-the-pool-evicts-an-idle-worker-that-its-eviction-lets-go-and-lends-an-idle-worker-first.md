# The pool evicts an idle worker that its eviction lets go, and lends an idle worker first

The pool kept each idle worker until the owner disposed it (#3516). On 2026-10-31, about 17 Vision helpers of old Codex plugin servers stayed alive with no jobs, each with a memory budget of 2 GiB. A host cannot see when its workers are idle, and the pool can. Thus this is a shortcoming of the pool, not of the host.

A job also took the lowest slot that no job had, whatever its state (#3495). A job then started a new worker in an empty, lost or back-off slot while a higher slot had an idle worker. A probe of `Fixed(2)` showed `idle: 1`, and the next job waited 302 ms for a new worker. Evicted workers make empty slots common, so both changes come together.

Mature pools agree on one form. The pool evicts, an idle worker goes to a job before a new worker starts, and jobs stay on a small set of workers so that the others stay idle long enough to be evicted. No pool counts an evicted worker as a failure.

| Pool                        | Evicts with                                                                                                       | Idle time                                              | Lends first                                                                                    | An evicted worker is a failure                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Apache Commons Pool 2.13.1  | an `EvictionPolicy` that the caller chooses (`BaseObjectPoolConfig.java:255`, `DefaultEvictionPolicy.java:55-57`) | 30 minutes (`BaseObjectPoolConfig.java:78`)            | an idle object before `create()` (`GenericObjectPool.java:298-300`), last in first out (`:41`) | no: its own count `destroyedByEvictorCount` (`GenericObjectPool.java:721-722`) |
| HikariCP                    | a housekeeper every 30 s (`HikariPool.java:63,118`)                                                               | `idleTimeout` 10 minutes (`HikariConfig.java:53`)      | the newest connection of the thread first (`ConcurrentBag.java:163-165`)                       | no: a normal close with a reason (`HikariPool.java:830-845`)                   |
| generic-pool                | an evictor function (`lib/DefaultEvictor.js:4-20`)                                                                | `idleTimeoutMillis` 30 s (`lib/PoolDefaults.js:17-27`) | starts only the workers that it lacks (`lib/Pool.js:229-237`)                                  | no (`lib/Pool.js:132-150`)                                                     |
| Go `database/sql`           | one cleaner with one timer (`sql.go:1101,1166-1173`)                                                              | none until the caller sets one (`sql.go:1069-1074`)    | a free connection, the one idle for the shortest time (`sql.go:1336-1341`)                     | no: its own counts (`sql.go:541-543`)                                          |
| .NET thread pool            | each thread, with a timed wait (`WorkerThread.cs:127-134,226-236`)                                                | 20 s (`PortableThreadPool.cs:55`)                      | the thread that became idle last                                                               | no: a normal state                                                             |
| KEDA and the Kubernetes HPA | the autoscaler                                                                                                    | 300 s before it scales down                            | —                                                                                              | —                                                                              |

Apache Commons Pool explains its order in POOL-86: first in first out "tends to refresh all the idle objects, preventing them from becoming evictable".

## Decision

- `new Pool()` takes an `eviction`. An eviction is a class, as a startup and a sizing are ([ADR 0001](./0001-startups-and-sizings-are-classes-that-a-caller-chooses.md)). `NoEviction` evicts no worker. `IdleTimeout({ after })` evicts a worker that stays idle for `after` milliseconds.
- The option has no default. The repository forbids defaults, and the old implicit rule, keep each worker, caused #3516.
- An eviction gets a call `idle(busy, evict)` when a worker becomes idle. It calls `evict()` when the pool may evict the worker. The pool aborts `busy` when a job takes the worker, when the worker leaves its slot, or when the owner disposes the pool. The call is an event: the eviction gets no promise that it must handle (mutex ADR 0009).
- `IdleTimeout` throws a `RangeError` when `after` is not finite, is 0 or less, or is above 2,147,483,647. Node runs a timer with a larger delay after 1 ms.
- The pool evicts only a worker in a slot that the sizing runs. A worker that the sizing keeps but does not run is the worker that a sizing that learns tries ([ADR 0002](./0002-a-sizing-that-learns-compares-one-more-worker-between-two-windows.md)). When the sizing runs more slots, the idle workers in those slots get a new call to `idle`.
- The pool does not count an evicted worker as an exit. It does not replace the worker, it does not start a back-off, and it does not count an early exit ([ADR 0005](./0005-an-eager-pool-backs-off-before-it-replaces-a-worker-that-exited-early.md)). An evicted worker that ran 10 minutes ends the back-off, as a worker that exits after 10 minutes does.
- A job takes a slot in this order, each time the lowest slot: an idle worker, a worker that starts, an empty slot or a slot whose worker ended, and last a slot in a back-off. The lowest idle worker keeps the jobs on the low slots, so the high slots stay idle and are evicted. `#retire` closes the high slots first for the same reason.
- When a job ends and its worker exited during the job, an eager pool replaces the worker as it replaces an idle worker that exits. Without this, a job that takes an idle worker first leaves the dead slot empty.

## Consequences

- After the pool evicts every worker, the leader of `LeaderFirst` has already started once. New workers then start together: `LeaderFirst` orders only the first start.
- When a sizing that learns runs more slots, the pool starts a worker in each empty slot that it runs.
- A sizing that learns does not measure while new workers warm up.
- A pool with an eviction can show zero in each count of its stats and be healthy ([ADR 0004](./0004-a-pool-reports-its-stats-as-one-snapshot-of-counts.md)).

## Considered Options

- **A data object `{ after }`.** It needs a special value to mean "never". The repository routes by type, so "never" is its own class, `NoEviction`.
- **A minimum count of workers that the pool keeps.** No caller needs it: the Vision hosts want zero. It can come when a caller needs it.
- **Lend the worker that became idle last.** HikariCP and the .NET thread pool do this, and it also keeps the jobs on a few workers. The lowest slot gives the same effect with a simpler rule, and it agrees with the order of `#retire`.
- **A periodic sweep**, as HikariCP and Commons Pool do. It evicts a worker up to one period late, and it wakes the process when no worker is idle. A timer for each idle worker evicts on time and stops when a job takes the worker.
