# Every pool is a pool for the computer, and one owner pulls its jobs from a store that every host writes to

Status: Accepted 2026-11-20 (backlog #3527). Built on one computer: `PoolWorkers` campaigns, owns the workers of its computer, and pulls its jobs from the store (2026-11-16), and every host's `Pool` sends its jobs to that store (2026-11-20). `use` is gone.

Today each host builds its own pool. A host is one running copy of a program that builds the pool: each chat's context-compiler server, each CLI run. Several hosts on one computer thus run several full pools of Vision workers, and these pools compete for the Neural Engine:

- 9 of 13 Vision warm-ups failed at a load of 20 to 42 with about 17 helpers of other programs, and 0 failed at a low load (#2896).
- Every Vision warm-up compiles through the one `ANECompilerService` of the system, so the helpers of other programs starve it (#3868).
- A pool measures only its own jobs, so a sizing that learns does not yield to another program. On 2026-11-02 two programs together read 51 to 75 images a second. Pool 0.6.14 grew to 6 workers, and the other program fell from 38 to 32 images a second (backlog #3527).

Eviction ([ADR 0006](./0006-the-pool-evicts-an-idle-worker-that-its-eviction-lets-go-and-lends-an-idle-worker-first.md)) removes the cost of idle workers. It does not remove the duplicate pools under load.

## Considered Options

The options of 2026-11-01 (backlog #3527, map ticket 04):

- **A. A permit for each job.** Each host keeps its workers and takes one of N permits across programs. zukhruf has no counting semaphore across programs, and each host still warms its own workers.
- **B. One owner, and jobs over a socket.** Leader election picks one host. The other hosts send their jobs to it. A job in flight lives only in the memory of the owner, so the owner's crash loses it.
- **C. A program that the operating system runs.** launchd or systemd starts one owner. It needs a different setup on each operating system.
- **D. A shared store, and every host pulls.** Each host takes jobs from one durable store. Each host then warms its own workers.
- **B + D. One owner pulls from a shared store.** Ezz: "I like B and D", and then "I do not mind but I thought they are seperate options".

## Decision

B + D, single active consumer (map ticket 04, resolved with Ezz on 2026-11-03):

- On each computer, one host holds all the workers of a pool. This host is the owner. Leader election (`@zukhruf/election`) picks it. Any host that offers workers can own. (Ezz: "Yes, one owner"; "Yes, any host".)
- Every host writes its jobs to a durable store, the owner too. Only the owner takes jobs from the store. A job thus survives the end of its owner, and the next owner runs it. (Ezz: "Yes, durable".)
- The API is location-transparent. A host builds a pool and gives it jobs in the same way, wherever the workers run and however many computers take part. Ezz: "The pool itself should not be concerned where it is running and how many devices being used … It should by default be this way."
- The pool for the computer replaces the pool in one program. `use((worker) => …)` goes away, and every job is data ([ADR 0012](./0012-a-job-is-data-and-the-worker-kind-runs-it.md)). (Ezz, 2026-11-03, when the map was charted.)
- The design works on macOS, Linux and Windows. A facility of one operating system stays behind a seam.
- Warm-up, eviction, back-off and sizing stay in the pool, inside the owner ([ADR 0001](./0001-startups-and-sizings-are-classes-that-a-caller-chooses.md) to [ADR 0010](./0010-an-eager-pool-starts-a-worker-again-after-its-warm-up-fails.md)).

The leading systems have this shape. A Kubernetes controller runs in several replicas, and leader election picks the one replica that drains the work queue. A RabbitMQ queue with single active consumer gives its messages to one consumer at a time, and moves to the next consumer when that one goes.

## Consequences

- The pool composes packages of the standard library. Each gap that the design found went to the package that must have it, and was built before the pool (Ezz, 2026-11-13: "Anything that is missing then goes to the appropriate package"):
  - The store on one computer is `@zukhruf/sqlite-queue`, pg-boss's API on one SQLite file. Across computers it is pg-boss itself.
  - The owner is the leader of a `SqliteElection` of `@zukhruf/election`.
  - The news between hosts travels through `@zukhruf/sqlite-notify` on one computer, and through Postgres `LISTEN` / `NOTIFY` across computers ([ADR 0018](./0018-news-travels-by-push-through-the-notify-of-the-store-with-a-backstop.md)).
  - A socket between two programs of one computer is a pipe of `@zukhruf/pipes`.
- The pool uses only what pg-boss also has. A thing that only SQLite can do goes to the SQLite family, never into the queue as a new method (Ezz, 2026-11-13: "make sure that SQLite queue is meant to be 1:1 with pg boss").
- Each job costs a write to the store and a wake. On macOS one `send` took 0.12 to 0.14 ms (p50), against a Vision read of about 500 ms (research 20f).
- A host with workers that must not serve another host gives a name that only it uses ([ADR 0014](./0014-pool-and-pool-workers-take-one-worker-kind.md)).
