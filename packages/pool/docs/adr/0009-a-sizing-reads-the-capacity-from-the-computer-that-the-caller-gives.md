# A sizing reads the capacity from the computer that the caller gives

`Resources`, `HillClimbing` and `Gradient` find the capacity: one worker for each CPU, while each finds its memory free. `capacity.ts` read `os.availableParallelism()` and `process.availableMemory()` itself. `Climbing` reads the capacity in its constructor for its ceiling, and again after each window ([ADR 0007](./0007-a-sizing-that-learns-keeps-learning-in-steps-both-ways-and-pauses-between-steps-that-change-nothing.md)). Thus the tests of the pool could steer the capacity only through the process:

- 3 tests replaced `process.availableMemory` with `t.mock.method`. Every test of the file reads that function, so these 3 tests could not run at the same time as the others.
- 12 tests asserted `availableParallelism() >= 4` and failed on a smaller computer.
- 6 tests gave `memoryPerWorker: 1` only so that the free memory did not decide, and one test divided the real free memory to get room for four workers.

The rule of the workspace is that a library takes the value that it really reads as an input, and a test gives a plain object (tests never override the environment). [ADR 0008](./0008-the-pool-measures-and-waits-on-the-clock-that-the-caller-gives.md) made the clock an input for the same reason, and left the capacity for this step (#3599).

## Decision

- `Resources`, `HillClimbing` and `Gradient` take a required `computer` of type `Computer`: `{ availableParallelism(): number; availableMemory(): number }`. The sizing reads the capacity only from it.
- Production gives the two functions of Node: `{ availableParallelism }` of `node:os` and `{ availableMemory }` of `process`. Both work without their object.
- `Fixed` takes no computer: it reads nothing.
- The pool takes no computer. Only a sizing reads the capacity, and `Climbing` reads it in its constructor, before a pool exists.

## Considered Options

- **A computer on the pool, beside the clock.** The pool would give it to the sizing, so the `Sizing` interface would need a new member, also for `Fixed`, and `Climbing` could not set its ceiling in its constructor.
- **A `capacity()` function from the caller.** The rule "one worker for each CPU, while each finds its memory free" would move to each host. It is the knowledge of the pool.
- **A default of the real computer.** A forgotten input would read the process again, and a test could not see it. The clock is required for the same reason.
- **A required `computer` on the sizings that read the capacity.** This option was selected.

## Consequences

- Each caller of `Resources`, `HillClimbing` or `Gradient` gives `computer: { availableParallelism, availableMemory }`.
- A host that runs several pools on one computer can give each pool a part of the memory or of the CPUs.
- The tests of the pool give a plain object. No test replaces `process.availableMemory`, and no test depends on the CPUs of the computer that runs it.
