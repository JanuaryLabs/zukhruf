# The feed owns its position

A pass compares the rows of each table with what the feed saw before. A reader that was not running can find the changes of that time, and the deletes above all, only by this comparison. Thus the record of what the feed saw, its position, is the domain of the feed. The host does not need to know its format.

Debezium's embedded engine gives a precedent. The host names a file (`offset.storage.file.filename`), and the engine writes its offsets into it in its own format. Kafka's consumer gives a precedent for the time of the save: with auto-commit, a poll commits the offsets of the records that the last poll gave. Delivery is at least once.

Some hosts do not need the changes of the time when they were stopped. They only observe the owner while they run, for example to show a notice when a row changes.

## Decision

`new Changefeed(databasePath, positionPath?)` takes the path of the position file as an option. The host gives only the place where the feed can write. The presence of the path sets the kind of the feed.

With a path, the feed is durable:

- The position file is a SQLite file of the feed. It keeps the key columns of each table, and one fingerprint for each (table, key). The feed owns its format.
- The feed creates the file when the file is missing. A missing or empty file is a first run: each row gives a `read`.
- `watch({ interval, signal })` gives batches. The feed saves the position of a batch when the host asks for the next batch. It writes the position in one transaction.
- The host makes no call to save. A loop that applies each batch before it goes on gets each event at least once.
- A process that stops before the loop asks for the next batch gives the same batch again at the next run. A loop that stops with `break`, an error or an abort also gives its last batch again: the feed cannot tell a loop that applied the batch from a loop that failed on it.

Without a path, the feed observes from now:

- The first pass of each `watch` is the baseline. It reads each table, keeps the fingerprints in memory, and gives no batch.
- Each later pass gives the changes after the baseline, and the feed keeps the new position in memory.
- The feed writes nothing to disk. A new run takes a new baseline, so it does not see the changes that the owner made while the feed was stopped. That is the meaning of an observer.

Other systems join the start of a reader to the presence of a durable position in the same way:

- Kafka's `auto.offset.reset` applies only when a consumer has no committed offset. `earliest` reads each record again, and `latest` reads only the records that come after the consumer starts.
- Spring Cloud Stream gives `earliest` to a consumer with a group, which keeps committed offsets, and `latest` to an anonymous consumer, which has no group. A durable feed is the first case, and a feed with no path is the second.
- CockroachDB `initial_scan = 'no'` gives only the changes after the changefeed starts.
- Debezium `snapshot.mode = no_data` (before, `never`) skips the first snapshot, and gives the changes from the current position of the log.

## Considered Options

- **The host keeps the state.** The feed gives a JSON state with each batch, and the host saves it. The host must then keep a record whose meaning it does not know, and save it at the correct time. Each host repeats the same work.
- **The feed keeps the position in memory only.** A new process cannot go on. Each row gives a `read` again, and the rows that the owner deleted while the reader was not running never give a `delete`. This is correct only for a host that observes, so it is the feed with no path, not the only kind.
- **The feed saves the position before it gives the batch.** A stop after the save and before the host applies the batch loses the batch.
- **The host calls a method to save.** It is a second step that each host must remember. The request for the next batch tells the same thing.
- **A separate start option (`earliest` or `latest`) next to the path.** No consumer needs a durable feed that starts from now. The presence of a durable position already sets the start, as the defaults of Spring Cloud Stream do. This option is rejected for now.
- **An optional position path: a durable feed with a path, a feed that observes from now without one.** This option was selected.

## Consequences

- The host needs no state, and it does not know the format of the position.
- A host of a durable feed that cannot apply an event twice with no effect must remove duplicates itself.
- The position grows with the number of rows of the database: on disk for a durable feed, in memory for a feed that observes.
- Two durable feeds must not share one position file.
- The position file is a second file on the disk of the host, next to the copy of the host. A host that deletes it makes the next run a first run.
- A feed that observes from now reads each table one time at start, and gives no events for that read.
