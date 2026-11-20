# News travels by push through the notify of the store, with a backstop

Status: Accepted 2026-11-20 (backlog #3527). Built on one computer (2026-11-20): the owner listens on "a new job" and tells "an output" after each settle; each `Pool` listens on "an output" before it sends, tells "a new job" after each send and again while its job waits, and reads the store at each wake and at its backstop of 1 s. News that comes while the owner's fetch or a result's read of the store is out is counted, so it is not lost (`docs/copied-code.md`). Postgres `LISTEN` / `NOTIFY` waits for ADR 0025.

Two kinds of news travel between the hosts of a pool (map tickets 10 and 11):

1. A host wrote a new job, and the owner must learn it.
2. The owner wrote the output of a job, and the host whose `run` waits must learn it.

A third kind, "the owner left", is the election's ([ADR 0024](./0024-a-hung-owner-is-ended-by-the-election-and-its-late-acts-are-fenced.md)).

pg-boss's `NOTIFY` wakes only the loops of `work`, and pg-boss has no wait for an output (research 10 and 17). The owner calls `fetch` ([ADR 0017](./0017-the-owner-asks-then-takes-as-many-jobs-as-it-has-free-workers.md)), so neither kind of news reaches it through the queue.

The mature one-file queues poll (Solid Queue 0.1 s, Huey 0.1 to 10 s, Oban Lite 1 s). Where a server exists, the leading queues push and keep a backstop poll: pg-boss `LISTEN` / `NOTIFY`, BullMQ `XREAD BLOCK`, Celery on Redis `SUBSCRIBE` (research 10). Ezz asked for push ("I'm just looking to use push more since others can tell us when they are ready ... instead of always asking"), and decided that the size of the work is no reason against it (2026-11-13). SQLite had no push, so the gap went to the SQLite family: `@zukhruf/sqlite-notify`, with no hub (Ezz, 2026-11-14: "go ewith recomendation").

## Decision

From map ticket 11, resolved 2026-11-14 from ticket 20 and the measures of research 20d and 20f:

- **Push on both scopes**, through the notify of the store: `@zukhruf/sqlite-notify` on the store file of one computer, and Postgres `LISTEN` / `NOTIFY` on the store that a `postgres://` address names. The pool uses one interface for both, so the code of a host does not change with the scope.
- **Two channels for each pool**:
  - "A new job". The owner listens. The payload is the revision of the job, because each revision has its own queue ([ADR 0022](./0022-the-newest-revision-takes-over-and-an-owner-refuses-a-job-of-an-older-revision.md)).
  - "An output". Each `Pool` that has a waiting `run` or `result` listens. The payload is the job id, so a host reads only its own jobs. In research 20f the id cut the reads of a caller from 6.5 to 1.05 a job, and its CPU by 35 to 40 %.
- **The store is the truth, and the wake is a hint**, as in sqlite-notify ADR 0002. The pool notifies after the write of the store committed: after `send` on "a new job", after `complete` or `fail` on "an output". A host that reads its news reads the state of the job in the store (`findJobs(name, { id })`), never the wake.
- **Listen first, then read once.** A `Pool` listens on "an output" before it sends, then reads the state of its job once, then reads again at each wake with the id of that job. An output that came early is not lost. Every push design that research 10 read does this, and it is the start rule of Postgres and of sqlite-notify.
- **The backstop.** At each backstop interval, the owner fetches when it has free workers, and each `Pool` reads the state of each of its waiting jobs. A `Pool` with a job that still waits sends "a new job" again with its revision, so an owner of another revision learns of it (ADR 0022). The interval is 1 s on one computer, as the backstop of sqlite-notify. Across computers it is pg-boss's rule for a backstop with notify on, `max(30 s, pollingInterval)` (`pg-boss/dist/attorney.js:601`), until a second computer is real and it is measured there. The backstop finds two things that no wake tells:
  - a wake that was lost, because its host ended between the commit of the store and its notify;
  - a job that the store's monitor failed, for example after its heartbeat stopped. No host notifies then.

## Transport limits

- The payload of a notification is shorter than 8000 bytes (Postgres, and sqlite-notify C6). The pool sends at most a job id or a revision.
- A channel name is shorter than 64 bytes. The name of a worker kind is short enough for both of its channels ([ADR 0014](./0014-pool-and-pool-workers-take-one-worker-kind.md)).
- A notify that fails because the notification queue is full (`QueueFullError`, Postgres `54000`) is a lost wake. The job is already in the store, and the backstop finds it.
- A socket path is at most 103 bytes on macOS and 107 on Linux. sqlite-notify keeps its sockets in `/tmp/zukhruf-sqlite-notify-<uid>/`, at most 70 bytes, through `@zukhruf/pipes`. The store's own folder can be long.
- A job carries JSON with references to its files, never the bytes ([ADR 0012](./0012-a-job-is-data-and-the-worker-kind-runs-it.md)). SQS caps a message at 1 MiB, and Celery and Azure send a reference (research 03).

## Consequences

- Push was faster than or equal to every poll in each cell that research 20f measured but one: jobs of 20 ms with 14 callers on macOS, where the commits of the callers and the owner collide (1 to 10 % slower). A Vision read takes about 500 ms.
- An idle host costs about 0.01 to 0.05 % of a core for the backstop of sqlite-notify (research 20c).
- The pool does not use the `notify` option of a queue. In pg-boss that wake reaches only the loops of `work`, and the pool keeps to what pg-boss does.
- Across computers, two things are not researched: how the pool sends its `NOTIFY` in the transaction of pg-boss's `send` and `complete`, and what a lost connection does. They wait for a second computer ([ADR 0025](./0025-many-computers-share-one-postgres-store-and-each-computer-keeps-its-own-owner.md)).
