# A change watcher yields each check with the keys that changed

The sources of elt watch their upstream with 17 hand-written `observe()` loops. Each loop reads one or more versions of a store, for example the `data_version` of a SQLite file. It waits a poll interval, reads the versions again, and compares each version with the version of the previous read. The planned `@zukhruf/sqlite-changefeed` needs the same loop a next time: its `watch({ interval, signal })` polls the data version, and makes a pass only when the data version changed. That is far more than three places, so the Rule of Three of the [zukhruf ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md) moves the loop into one home. This package already has `poll`, and all the consumers can depend on it.

## The working copies

The 17 loops are in `packages/sources/*/src/*-source.ts` of elt:

- 10 loops read one version: Apple Messages, Call History, Contacts, Accounts, Wallet, Notification Center and Notes, Microsoft Teams, Slack, and Google Health.
- 5 loops read one version for each store: Apple Books, Safari, Clock and Activity, and WhatsApp. They keep a `Map` of the previous versions, and give the streams of the stores that changed.
- Apple Mail reads two versions. A change of the mail version gives all streams. A change of the accounts version gives only the account streams.
- Microsoft SQL Server reads two versions in one call. It also gives its full refresh streams on a schedule.

The shared part of all 17 loops is one function, `pollChanges`:

1. When the signal aborted before the first check, end, and do no read.
2. The first check reads each value at once, and yields all keys: the consumer has never seen the values.
3. Wait `interval` milliseconds with `untilAborted(delay(interval, undefined, { signal }), signal)`, as `poll` does ([ADR 0003](./0003-the-election-and-the-file-lock-stores-poll-through-one-function.md)).
4. Read each value again, one after the other, in the order of the map. Compare it with `===` to the value of the previous check. Yield the set of the keys whose value changed. The set can be empty.
5. Go to step 3.

The differences become parameters. The number of values is the size of the map: a loop that reads one version gives a map with one key. The key is the thing that the consumer gives back for a change, for example a store or a group of streams. The interval is a parameter, because the loops use different intervals (1 second for Clock, `pollIntervalMs` for the others).

Some rules are different in kind, and they stay with each consumer:

- What a change means. Mail gives all streams for a change of its mail version, and the account streams for a change of its accounts version. It reads both changed keys in one set, and applies its own rule.
- A schedule. SQL Server gives its full refresh streams after a time, also when no version changed. The web pages source and Google Search Console wake on a due time. A schedule is not a change of a value.
- Work between two checks. Notes starts the Notes app again on its own schedule. It can do this in its read.
- Change notifications. Apple Calendar and Reminders get a notification from EventKit for each change. They do not poll, and they do not use `pollChanges`.

## A check that found no change still yields

`fs.watchFile` of Node.js and `distinctUntilChanged` of RxJS give a value only when it changed. `pollChanges` yields each check, also a check that found no change. The elt pipeline needs that check:

- `Source.observe` of elt core (`packages/elt/src/core/source.ts`) says: "A check that finds nothing changed still yields, so readers see the unchanged streams current as of it."
- `Pipeline.#watch` (`packages/elt/src/core/pipeline.ts`) records `history.checked` for each stream that was loaded, is not pending, and is not loading, on each yield of the watcher. Without the empty yield, the history does not record that an unchanged stream is current.

Thus the empty yield is not a by-product of the loops: elt relies on it. A consumer that needs only the changes skips an empty set. The changefeed does that: a check with no change makes no pass.

`pollChanges` makes no check that no consumer needs. It reads only when the consumer asks for the next check. It does not yield between two checks.

## An abort ends the iteration

When the signal aborts during the wait, `pollChanges` stops the timer of the wait and ends. The `for await` loop of the consumer then ends with no error. The 17 loops do the same: they catch the `AbortError` of `setInterval` and return. `poll` rejects with the reason of the signal, because a poll that ends must give a value or an error. An iteration has a third way to end: it can end with no more values. An abort tells the watcher that the consumer stops, so the iteration ends.

A consumer that must reject calls `signal.throwIfAborted()` after its loop. The changefeed does this: its loop rejects with `signal.reason`. The other way does not work as well: when the watcher rejects, each elt source must catch the reason of the signal, and the reason can be any value.

An abort does not stop a read that runs, as for `poll`. An error from a read rejects the iteration with the same error, also an error that the abort caused in the read. The elt pipeline already ignores an `AbortError` after its signal aborted.

## Considered Options

- **Keep 17 copies.** Each correction must go into 17 places. The copies already differ: two of them check `signal.aborted` before they ignore an `AbortError`, and 15 do not.
- **Yield only a change, as `fs.watchFile` and `distinctUntilChanged` do.** The elt pipeline then cannot record a check that found no change.
- **One function for one value, and each multi-store loop compares its own map.** Five loops, Mail and SQL Server would keep their own copy of the comparison of each key.
- **A comparison function as a parameter.** All 17 loops compare versions with `===`, as `distinctUntilChanged` does by default. No consumer needs another comparison.
- **The `ref` option of `poll`.** No consumer needs a watch that does not keep the process alive. The elt watch and the changefeed watch run in the foreground. A `ref` option waits for a consumer that needs it.
- **`setInterval` of `node:timers/promises`.** It counts the ticks that the consumer did not take, and gives them at once when the consumer asks again. After a long pass, a loop then reads two times with no wait. `pollChanges` waits the full interval after the consumer asks for the next check.
- **A function in this package that yields each check with the set of the keys that changed.** This option was selected.

## Consequences

- A correction to the watch loop goes into one place.
- The name `pollChanges` is not an industry term. It joins the poll of this package and the change of `distinctUntilChanged`. Node.js calls stat polling "watch" (`fs.watchFile`).
- A loop that reads one value gives a map with one key. It tests `changed.size > 0`.
- The elt sources move to `pollChanges` after its release (phase 2 of the changefeed plan). Calendar, Reminders, Instagram, the web pages source and Google Search Console keep their loops: they do not compare values.
- `@zukhruf/sqlite-changefeed` uses `pollChanges` for its data version.
