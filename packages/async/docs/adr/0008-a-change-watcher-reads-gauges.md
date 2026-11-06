# A change watcher reads gauges

[ADR 0004](./0004-a-change-watcher-yields-each-check-with-the-keys-that-changed.md) gave `pollChanges` one read for each key. [ADR 0007](./0007-a-check-is-one-read-that-gives-the-value-of-each-key.md) gave it one read for each check, which returns a map from each key to its value. Each form fit some consumers and forced the others to adapt. With one read for each key, a consumer whose one query gives the values of many keys shared a cache between closures and relied on the order of the reads. With one read for each check, a consumer that holds a read for each store had to join its reads into one, the same three lines in each consumer (#3840).

Both forms mix three jobs: the schedule of the checks, how a check reads, and what the values stand for. This decision gives each job its own concept, from the domain of polling, not from a consumer. Prometheus scrapes gauges and collectors, Kubernetes informers list many keys in one read, and the Signals proposal of TC39 compares each value with `Object.is`.

## Decision

- A **gauge** is a value that a change watcher reads at each check. A subclass of `Gauge` says how to read it. `value(check)` reads it at most one time in a check.
- A **collector** is one read that gives the values of many keys. `collect` runs at most one time in a check, however many of its keys are watched. `gauge(key)` gives the gauge of one key. A collector gives no `undefined` value (`Sample`), so the `undefined` of a gauge means only that the read did not give the key.
- A **group** is a gauge made of gauges. Its value is the values of its members. It keeps a copy of its members, so it cannot contain itself.
- A **period** is the count of whole periods since the watch started. It counts from the start of the watch, not from the clock: a watch that starts at 07:12 reads its next hour at 08:12.
- A **check** carries the start of the watch, the time of the check, and a signal that aborts when the watch stops or the check passes its timeout.
- `new ChangeWatcher(gauges, { interval, timeout, clock }).watch(signal)` yields, at each check, a map from each gauge to its **outcome**: changed, unchanged, or failed with the error. The outcome is one value for each gauge, so a gauge cannot be changed and failed at once.
- A value is a primitive or a list of values. Two values are the same when `Object.is` says so, member by member for a list. Thus `NaN` does not change at each check.
- The reads of a check run at the same time. A read that takes longer than `timeout` fails for that check, also when it ignores the signal: the watcher stops waiting for it. One slow read thus does not hold up the other gauges.
- A failed read fails only its gauge. The gauge keeps its last value, and changes only when a later read gives another value. The consumer decides what a failure means.
- An abort ends the iteration with no error: during the wait, during the reads, and also while the consumer holds a check.
- `interval`, `timeout` and the length of a period are positive, finite numbers of milliseconds. Another number throws a `RangeError`.

These rules of ADR 0004 stay: the first check reads at once and each gauge that it reads changed; a check with no change still yields; the wait starts when the consumer asks for the next check; the watch runs on the clock that the caller gives ([ADR 0005](./0005-a-wait-runs-on-the-clock-that-the-caller-gives.md)).

## Considered Options

- **One read for each key, the form of ADR 0004.** A read that gives many keys needs a cache that the consumer keeps between checks.
- **One read for each check, the form of ADR 0007.** Each consumer with many reads joins them, for example with `p-props`.
- **A map from each subject to its gauges, which yields subjects.** A thin layer over this decision. It makes grouping a second concept beside the gauge. A consumer maps the changed gauges to its own subjects in one line.
- **A memo of each check inside `Check`, keyed by object.** It needs a type assertion to give each read its own type back.
- **A failed read fails the watch, as in ADR 0004.** One locked store then stops the watch of every other store. Prometheus marks a failed target and scrapes the others.
- **`===` to compare.** `NaN !== NaN`, so a gauge that reads `NaN` changes at each check.
- **Gauges, collectors, groups and periods.** This option was selected.

## Consequences

- `pollChanges` is removed. Each consumer moves to `ChangeWatcher` in the release that brings it.
- A consumer writes a small class for each kind of value that it reads, or the store that it reads gives one.
- A consumer chooses a timeout for its reads.
- A consumer reads the outcome of each gauge, and decides what a failed gauge means.
