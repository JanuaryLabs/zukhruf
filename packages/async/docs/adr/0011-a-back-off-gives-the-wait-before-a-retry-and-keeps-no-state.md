# A back-off gives the wait before a retry and keeps no state

A caller that tries an operation again after a failure waits longer after each failure, up to a limit: a capped exponential back-off. Three places in this workspace compute it by hand (#3157):

- `patiently` of `@zukhruf/fs` waits 5, 10, 20… ms, at most 100 ms, between two tries of a Windows file operation.
- `@zukhruf/pool` waits 1, 2, 4… s, at most 60 s, before it restarts a worker that exited early.
- The job settler of `@zukhruf/sqlite-queue` sets the next start of a failed job, with the back-off of pg-boss.

The paper of `@zukhruf/election` adds a fourth: a candidate that waits 25 ms, then 1.6 times more after each failed connect, at most 1 s, ±20 %. Nine more places in other repos do the same. Each copy keeps its own formula, and the formulas differ only in their numbers and in their jitter. The Rule of Three of [root ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md) thus gives the back-off one home. [Election ADR 0008](../../../election/docs/adr/0008-the-backend-owns-the-wait-between-two-tries-and-poll-leaves-the-campaign.md) names this package as that home.

## Decision

This package exports `Backoff`. A caller configures it once. `backoff.duration(retries)` gives the wait in milliseconds before the next retry. `retries` is the number of retries before this wait: 0 before the first retry. The object keeps no other state. The caller keeps its own count of retries, and waits with `delay(ms, { clock, signal })`.

A retry is a new try of an operation after it failed, as in `patiently` of `@zukhruf/fs`. The glossary keeps "attempt" for one call of a poll, so this package does not call the count an attempt, as AWS and Polly do.

```ts
import { Backoff, delay } from '@zukhruf/async';

const backoff = new Backoff({
  initial: 25,
  multiplier: 1.6,
  max: 1_000,
  jitter: { kind: 'ratio', ratio: 0.2 },
});
for (let retries = 0; !(await connect()); retries++) {
  await delay(backoff.duration(retries), { clock, signal });
}
```

The wait without jitter is `d = min(max, initial · multiplier^retries)`. The jitter is one of four kinds. Each kind is the formula of its source, with `R` from `random()`, a number in [0, 1):

| `jitter`                      | Wait                                                                                                   | Source                                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ kind: 'none' }`            | `d`                                                                                                    | AWS, "Exponential Backoff And Jitter" (Brooker, 2015): `min(cap, base * 2 ** attempt)`                                                                                                                                             |
| `{ kind: 'ratio', ratio: r }` | `d + d · r · (2R − 1)`, so `d` ± `r · d`. The wait before the first retry is `initial`, with no jitter | gRPC, `doc/connection-backoff.md`: `current_backoff + UniformRandom(-JITTER * current_backoff, JITTER * current_backoff)`, after `Min(current_backoff * MULTIPLIER, MAX_BACKOFF)`. The first deadline is `now() + INITIAL_BACKOFF` |
| `{ kind: 'full' }`            | `R · d`                                                                                                | AWS article: `random_between(0, min(cap, base * 2 ** attempt))`. AWS SDK v3 `computeNextBackoffDelay(i)` does the same, then rounds down                                                                                           |
| `{ kind: 'equal' }`           | `d / 2 + R · d / 2`                                                                                    | AWS article: `temp / 2 + random_between(0, temp / 2)`, with `temp = min(cap, base * 2 ** attempt)`                                                                                                                                 |

- The `ratio` jitter applies after the cap, as the gRPC spec does. Thus a wait can be up to `(1 + r) · max`. The `full` and `equal` jitters stay within the cap, as the AWS formulas do.
- `random` is an input, as the clock is ([ADR 0005](./0005-a-wait-runs-on-the-clock-that-the-caller-gives.md)). The default is `Math.random`. A test gives a function that returns known numbers, and then asserts exact waits.
- The constructor refuses incorrect options with a `RangeError`, as `milliseconds()` does: `initial` must be a positive, finite number; `multiplier` a finite number of 1 or more; `max` a finite number of `initial` or more; `ratio` a number above 0 and at most 1. `duration` refuses a count of retries that is not an integer of 0 or more.

`Backoff` does not decide when to stop, when to start again from 0 retries, which failures to try again, or what to do with a `Retry-After` header. These are rules of each caller:

- `patiently` stops after one second, the pool after a dispose. The HTTP copies stop after 2 to 30 tries.
- The pool starts again from 0 retries after a worker that lived ten minutes. The election starts again after a connect.
- `Retry-After` is an HTTP header. The leaders read it in their HTTP packages: `RetryAfterHelper` of Microsoft.Extensions.Http.Resilience, `failsafehttp` of failsafe-go, Got, and `middleware-retry` of the AWS SDK. Each one combines it with the back-off in a different way.

## Considered Options

- **A stateful back-off: `next()` and `reset()`.** cenkalti/backoff has `NextBackOff()` and `Reset()`. Kubernetes `wait.Backoff` has `Step()`, which changes its own value. sethvargo/go-retry has `Next()`. Each consumer in this workspace already keeps its count of retries: `slot.early` of the pool, the loop of `patiently`, `retry_count` of the queue, and the tries of the election. A second count in the back-off can disagree with the count of the caller. A function of the count adds no state, and a test asserts the wait for each count directly. AWS SDK v3 (`computeNextBackoffDelay(i)`), Polly v8 (the delay from `AttemptNumber`) and grpc-go (`Backoff(retries)` of `internal/backoff`, recalled, not read again for this ADR) take the count.
- **A wait in the back-off: `await backoff.wait(signal)`.** The queue stores a start time in a row, and the pause of the pool's climbing stores a resume time. Neither one waits on a timer, so both need the number. `delay` already does the wait.
- **A ratio as the only jitter**, as gRPC, cenkalti and failsafe-go have. The queue must keep the parity of pg-boss, which uses the equal jitter. The AWS SDK and elt's Google client use the full jitter.
- **The decorrelated jitter** of the AWS article (`min(cap, random_between(base, sleep * 3))`), or Polly's decorrelated jitter V2. Each wait depends on the last wait, so it needs state. No copy uses it.
- **An additive jitter** (`d + R · c`), as Got, Kubernetes and the inbox of text2sql have. No copy in this workspace uses it. A caller can add it to the duration.
- **A hard cap after the jitter**, as Polly's `MaxDelay` does. The gRPC spec applies the jitter after the cap, and the election follows gRPC.
- **No cap, or a default for each option**, as p-retry and Polly have. The copies use initial waits from 5 ms to 2 s and caps from 100 ms to 60 s, so no default fits. An uncapped back-off grows with no limit.
- **A budget of retries or of time in the back-off**, as Kubernetes `Steps` and sethvargo's `WithMaxRetries` have. cenkalti v5 moved its `MaxElapsedTime` out of the back-off into `Retry`. The budgets of the copies differ in kind: one second, a count of tries, never.
- **A `Backoff` with a `duration(retries)` method, four kinds of jitter and a random input.** This option was selected.

## Consequences

- `Backoff` and `duration` are the words of this package. `Backoff` is the common name (Kubernetes, cenkalti, sethvargo). The leaders name the method `computeNextBackoffDelay` (AWS), `NextBackOff` (cenkalti) and `Step` (Kubernetes). `delay` is the name of the wait of this package, so the method is `duration`: a word that this package chose.
- A wait can have a fraction of a millisecond. The AWS SDK rounds down; `delay` accepts a fraction.
- The next steps switch the copies: `patiently`, the restart and the climbing pause of the pool, the job settler of the queue, then the election when it is built. The external copies switch when a release has `Backoff`.
- pg-boss computes `base · 2^(e−1) · (1 + R)` with `e = min(16, retry_count + 1)`, and caps it after the jitter. `{ initial: 2 · base, multiplier: 2, max: base · 2^17, jitter: { kind: 'equal' } }` gives the same waits when the job has no `retry_delay_max`. With a `retry_delay_max` between the half and the whole of the wait, pg-boss gives the cap and `Backoff` gives a random wait under it. The switch of the queue must keep the parity of pg-boss, so it must decide this case.
