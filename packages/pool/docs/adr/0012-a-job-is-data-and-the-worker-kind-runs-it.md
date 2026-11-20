# A job is data, and the worker kind runs it

Status: Accepted 2026-11-20 (backlog #3527). Partly built (2026-11-16): `Worker` has `run(input)`, and `PoolWorkers` runs each job on it with the input of the job's envelope, `{ input }`. `pool.run` is not built yet.

`use((worker) => …)` gives the job a function. A function cannot go to another program, so a pool that serves several hosts cannot take one ([ADR 0011](./0011-every-pool-is-a-pool-for-the-computer-and-one-owner-pulls-its-jobs-from-a-store-that-every-host-writes-to.md)).

Every mature pool that spans programs sends a name and data, and keeps the code where the worker is (map ticket 01, research 01):

| System                   | A job is                                | The code that runs it is             |
| ------------------------ | --------------------------------------- | ------------------------------------ |
| Celery                   | a task name and its arguments           | in the task registry of the worker   |
| Temporal                 | an activity type and its payload        | in `Worker.create({ activities })`   |
| Piscina, Tinypool        | a cloned value                          | an export of the worker file         |
| pg-boss                  | a queue name and JSON data              | the handler of `work(name, handler)` |
| Bazel persistent workers | a `WorkRequest` (arguments, inputs, id) | the worker program itself            |

Only Ray sends a function, because every side of it is the same Python program. Ray's `ActorPool.submit(fn)` gives the worker to a local function, as `use` does, so it works only inside one program.

## Decision

From map ticket 05, resolved with Ezz on 2026-11-03:

- `await pool.run(input, { signal })` resolves with the job's output. The verb is `run`, as in Piscina and Tinypool. (Ezz: "run".)
- The code of the job is in the worker class. A `Worker` gets `run(input)`, which resolves with the output. Temporal activities and Bazel persistent workers have this shape. (Ezz: "A: in the worker class".)
- The input and the output are JSON. A file goes by reference: a path on one computer, a SHA-256 across computers ([ADR 0025](./0025-many-computers-share-one-postgres-store-and-each-computer-keeps-its-own-owner.md)). The pool never carries the bytes of a file. pg-boss keeps JSON data and output, Celery and Temporal send serialized payloads, and SQS and Azure send a reference for a large payload (research 03).
- The worker's own JSON line is not the job. A Claude turn sends one prompt and reads many lines until `result`, and the lines that remain would answer the next job.

```ts
export interface Worker<Input, Output> {
  run(input: Input): Promise<Output>;
  ready?(): Promise<unknown>;
  exited(): Promise<unknown>;
  kill(): void;
  close(): Promise<void>;
}
```

## Consequences

- A `Coprocess` worker writes the input as one JSON line and reads its answer, as `VisionWorker.read({ path })` does today.
- The job id is in the pool's envelope on the job, not in the worker's line. A worker does one job at a time, as Bazel's singleplex workers do.
- The answer parse and the mapping of the worker's `{ error }` stay in the worker class. The time limit of a job moves to the worker kind, which the owner applies ([ADR 0019](./0019-run-waits-and-a-failed-job-rejects-with-the-pools-error.md)).
- `Worker.run` takes no signal. The owner stops a job only with `kill()`. Ezz decided on 2026-11-16: "Kill only for now (Recommended)". A cancel signal on `run`, Bazel-style, comes when a costly kind that cannot be shared has a worker that can cancel (README, "Decided").
