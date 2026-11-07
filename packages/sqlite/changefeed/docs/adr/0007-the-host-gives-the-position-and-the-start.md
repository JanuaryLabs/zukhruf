# The host gives the position and the start

ADR 0004 let the presence of a position path set the kind of the feed. With a path, the position was a file, and the first run gave each row as a read event. Without a path, the position was in memory, and each run started with a baseline. Thus one optional argument set two separate things: where the feed keeps its position, and what the first pass gives.

ADR 0004 considered a separate start option, and rejected it: "No consumer needs a durable feed that starts from now." Ambient, in context-compiler, is that consumer. It follows 21 imports with about 7.7 million rows (2026-11-07). It sends a notice for a change, not for each row that was there before it started. With a position file, its first run gave 7.7 million read events. With no position, it did not see the changes of the time when it was stopped.

Two other things were wrong in the code. The feed kept the kind of each run in a boolean, `baseline`. A baseline also made each read event with its full row, and then discarded the events.

## Decision

`new Changefeed(databasePath, { position, start })` takes two strategies. Both are required.

- `position` is a `Position`: where the feed keeps what it saw. `PositionFile` keeps it in its own SQLite file. `PositionInMemory` keeps it in memory. The feed owns the position that it gets: it disposes it, also when `new Changefeed` throws.
- `start` is a `Start`: what the first pass gives for each table, until a pass saves the position. `ReadEveryRow` gives a read event for each row. `Baseline` keeps the fingerprint of each row, and gives no events.
- A position tells whether a pass saved it (`started()`). A `PositionFile` keeps this in the file: its `user_version` is 1 after the first save. A `PositionInMemory` keeps a saved phase that holds the tables, and a phase before the first save that holds none.
- After the first save, a table that the position does not have gives a read event for each row, with each start. Thus a baseline of a database with no tables does not hide a table that the owner creates later.
- Each of the four combinations is correct. A `PositionFile` with `ReadEveryRow` copies each row one time, and then follows the changes. A `PositionFile` with `Baseline` follows the changes from its first run, also across stops. A `PositionInMemory` with `Baseline` observes while it runs. A `PositionInMemory` with `ReadEveryRow` loads each row at each run, for a copy in memory.

Other systems keep the two choices apart:

- Debezium keeps its offsets in a store that the host selects (`offset.storage`: a file, Kafka or memory). It selects the first snapshot with `snapshot.mode`: `initial` reads each row, and `no_data` reads none. A custom mode is a class of its `Snapshotter` interface.
- Kafka keeps the committed offsets of a consumer group. `auto.offset.reset` applies when the group has no committed offset: `earliest` reads each record, and `latest` reads only the later records.
- `@zukhruf/sqlite-open` gives the journal of an owner as a strategy, `Journal`, with one class for each journal ([ADR 0004 of that package](../../../open/docs/adr/0004-the-journal-is-a-strategy.md)).

## Considered Options

- **The presence of a position path sets the kind (ADR 0004).** It cannot give a durable feed that starts from now.
- **A path and a start string (`{ position?: string, start: 'everything' | 'now' }`).** The behavior of each start is then a branch in the pass, and the feed keeps the boolean.
- **Named constructors (`Changefeed.durable(path, { start })`, `Changefeed.observing()`).** They keep two kinds, and they give no position in memory that reads each row.
- **The start as an argument of the position (`new PositionFile(path, new Baseline())`).** A position then owns what a pass gives, which is not what a position is.
- **Two strategies, `Position` and `Start`, both required.** This option was selected.

## Consequences

- The host writes the two choices at each `new Changefeed`. No default hides a choice.
- A new position, for example in the database of the host, is a class that implements `Position`. It can then keep the position in the same transaction as the work of the host.
- A new start is a class that implements `Start`. It gets each `Table` of the first pass, with its rows.
- A `PositionFile` writes its file when the host makes it, also when `new Changefeed` then throws for the database.
- A `Baseline` keeps no rows, only the fingerprints. A first pass with `ReadEveryRow` still gives all its events in one batch.
