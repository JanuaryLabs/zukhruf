# no-timer-race allows a race against a timer only when it asserts that the timer won

Status: Accepted on 2026-11-24 (#5487). Ezz chose "Accept".

A race between a promise and a timer that resolves a marker, such as `Promise.race([waiting, delay(500, 'pending')])`, ends the wait when the timer fires. The test then has a limit of its own. Under load, the promise comes later than the window, and the test fails. #5483 is such a failure: `docker-engine-store.test.ts:167` waited at most `heartbeatInterval + engineBound` (10.5 s) through the helper `outcomeOf`. In a full gate the tests of that file ran 11 to 26 times slower than alone, and the waiter came after 13.4 s.

`zukhruf/no-timer-race` reported a race only when an assertion compared its result with a value that is not the marker (the message `deadline`). The wait of #5483 and 23 others in zukhruf escaped it:

- The rule followed only the variable that held the race. A helper that returns the race, such as `outcomeOf`, `firstOf` or `grantedWithin` of `@zukhruf/mutex`, was not read.
- The rule read only `assert.<comparison>(result, …)`. A member read (`outcome.settled`), `assert.ok`, `===`, a result put into data, and a result that nothing reads were allowed.
- The rule compared markers by their text, with only a top-level `as const` removed.

## Decision

A race between a promise and a timer, in a test or a `src/testing` file, is allowed only when each read of its result asserts that the result is the timer's value (the marker). Any other read, and no read, is reported with the message `ownLimit`: await the promise through `untilAborted(promise, t.signal)` from `@zukhruf/async`, which ends at the test's limit, or assert that the result is the marker.

- These reads assert the marker: `assert.equal`, `strictEqual`, `deepEqual` or `deepStrictEqual` of the result and the marker, in either order; `assert.ok(result)` when the marker is `true`; `if (result !== marker)` with a branch that throws or calls `assert.fail`; `assert.ok(result === marker)`; a member of the result against the same member of an object marker (`outcome.settled` against `{ settled: 'pending' }`), also through destructuring; and `assert.notEqual(result, value)` with a value that is not the marker, which a late promise cannot fail.
- A read that only builds the report of a failure (the message of an assertion, an argument of `assert.fail`, what a `throw` throws) is not a read.
- Markers are compared by structure: the rule removes every `as` and `satisfies` cast, also nested ones, and every space outside a string.
- The timers are `delay`, `sleep` and `setTimeout` of `node:timers/promises`, also with `.then(…)` or `.catch(…)` after them, `new Promise((resolve) => setTimeout(…))`, whose callback timer calls `resolve`, and the `promise` of `Promise.withResolvers()` whose `resolve` a callback timer calls, also when another source calls its `reject`.
- A function whose body returns such a race is a helper. Each call of a helper is checked as the race itself, and the report is at the call. The rule finds a helper of the linted file by the scope of its name. It finds a helper of another file through the type checker, as `zukhruf/no-unhandled-readline-error` reads a function's body ([ADR 0012](./0012-no-unhandled-readline-error-counts-an-input-the-code-can-write-to.md)). It follows a helper that calls a helper, up to four helpers deep.
- `.then(() => assert.fail(…))` after a timer is a timer that rejects, as `.then(() => { throw … })` is (the message `matched`).

The leaders use a window of time only to prove that something does not happen. In Go, a test proves that a result stays away with `select { case <-done: t.Fatal(…); case <-time.After(d): }`, and waits for a result with `<-done`, which ends at the `-timeout` of `go test`. Mockito proves that a call does not come with `verify(mock, after(ms).never())`, which waits the whole window and then checks. Neither one asserts that the result came within the window. No function of `@zukhruf/async` or `@zukhruf/testing/async` says "still pending after n ms", so the rule adds no API: the marker assertion is that check.

## Considered Options

- **Report `Promise.race` with a timer in `zukhruf/no-own-wait-limit`.** That rule reports `settleWithin`, `AbortSignal.timeout` and `t.waitFor` (no-own-wait-limit.ts:151-172). `no-timer-race` already reads the race, its markers and its assertions, so a second rule would read the same race again and could disagree with it ([ADR 0001](./0001-one-key-per-check.md)).
- **Keep the default of allowing a race, and add the missed read forms one at a time.** Each new form of a read (a member, `assert.ok`, data, a helper) passes until a test fails under load. The inverted default reports a form that the rule does not know.
- **A helper `pendingAfter(promise, ms)` in `@zukhruf/testing/async`.** The marker race is already that check, and its assertion says what the test proves. A new API would change no site that the rule reports.

## Consequences

- On zukhruf at ddb9e5f0, the old rule reports 0 sites. The new rule reports 35 problems at 26 sites in 9 files, with type information: `docker-engine-store.test.ts` (13 calls of `outcomeOf`, the 13 sites of #5483), 3 calls of `grantedWithin` (`socket-store-coordinator.test.ts:217`, `socket-store.test.ts:1043`, `:1057`), `handshake.test.ts:44`, `socket-store-reconnect.test.ts:494`, and in `@zukhruf/sqlite-queue` and `@zukhruf/testing` 8 more. Without type information it reports 32: the 3 calls of `grantedWithin` are in another file. The change fixes each one. A wait for a result becomes `await untilAborted(promise, t.signal)`, and an expected rejection becomes a rejection of that wait. The 17 checks that the promise stays pending keep their marker form; `outcomeOf(waiting, 500)` of `docker-engine-store.test.ts:666` becomes a marker race in the test, because `outcomeOf` has no other call.
- elt reports 3 sites (`computed-dataset.test.ts:988`, `image-format.test.ts:611`, `search-console.test.ts:208`), and context-compiler 4 (`observer.live.test.ts:81`, `observer.test.ts:107`, `cli.e2e.test.ts:1655`, `plugin.e2e.test.ts:2060`). Each repo fixes its sites when it moves to the release of `@zukhruf/eslint` that has this change. The program of a child process in a template string, such as elt `src/index.test.ts:2641`, is not linted, so it is fixed by hand.
- A JavaScript test file, or a run without type information, has no program. The rule then follows only the helpers of the linted file.
- A helper of another file is read only when it returns `Promise.race([…])` itself, or the call of another helper. Its timers must be written in the race: a timer that the helper holds in a variable, or a block after `.then(…)`, is not read there.
- A test whose wait now ends at `t.signal` fails at the limit of the test target, not after a few seconds. `zukhruf/no-missing-test-timeout` makes sure that this limit exists.
