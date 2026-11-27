# Keyed state is a set of named map states, and a commit writes only what changed

Status: Accepted 2026-11-28 (backlog #6201).

Decision-makers: the zukhruf session mutex-d0, from the surveys of 2026-11-27.

A reader often keeps more than its position: a fingerprint for each row that it saw, a record for each URL that a crawl knows. This state grows with the input. When a commit writes it whole, each commit writes far more than what changed. elt measured it: one checkpoint of a web crawl held about 583 bytes for each URL, so a crawl of 160,000 listings would write about 93 MB at each page (elt ADR 0035, #4468). A whole value can also pass a limit: one checkpoint of Mail held 257,129,299 characters, about half of the largest string of V8 (536,870,888 code units), so a mailbox twice as large makes `JSON.stringify` throw (elt ADR 0036).

The engines that keep large state keep it as keyed values, and a commit writes only the changes:

| Leader        | Keyed state                                                                                                                 | A commit writes                                                                                                      | Source (survey C) |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Flink         | `MapState<UK,UV>` (`get`, `put`, `remove`, `contains`, `entries`, `keys`, `values`, `isEmpty`), by a descriptor with a name | incremental checkpoints "only record the changes that happened since the latest completed checkpoint"; the changelog | Flink c           |
| Kafka Streams | `KeyValueStore<K,V>` (`get`, `put`, `delete`, `range`, `all`), by a store name                                              | each change to a compacted changelog topic                                                                           | Kafka Streams c   |
| Spark         | `MapState` (`getValue`, `containsKey`, `updateValue`, `removeKey`, `iterator`, `clear`), by a state name                    | `.delta` files, "each set of updates increments the store's version"                                                 | Spark c           |

Flink scopes keyed state to the current key, and Spark keeps a store for each operator, partition and store name (`StateStoreId`). Flink 2 also has an async state API (`state.v2`), whose reads give a future, because a backend such as RocksDB reads from disk. Airbyte and Singer keep state inside one value, and they cap it in place of a delta: Airbyte keeps at most 25,000 partitions and above 10,000 it uses one global cursor; Singer's best practice is to "Limit State Growth" (survey C, Airbyte c, Singer c).

## Decision

1. `context.state(name, format)` gives the map state of that name in the partition of the context. Two map states never share a key. The format writes each value with a version ([ADR 0004](./0004-a-position-is-an-opaque-json-value-with-a-format-version-and-it-names-the-next-record-to-read.md)).
2. A map state uses the words of a JavaScript `Map`: `get`, `has`, `entries`, `set`, `delete` and `clear`. A key is a string.
3. `get`, `has` and `entries` are async. They read the committed values from the store, and the changes of the context over them. Thus a map state can be larger than memory.
4. `set`, `delete` and `clear` change only the memory of the context. The next commit writes these changes and nothing else ([ADR 0007](./0007-a-commit-saves-the-position-the-state-changes-and-the-next-checkpoint-id-together-and-can-write-the-output-in-the-same-transaction.md)).
5. A commit that fails keeps the changes in the context, so that a retry of the commit writes them.

## Considered Options

- **The state in the position, as Airbyte and Singer.** A commit writes the whole value. This is the fault of elt before ADRs 0035 and 0036.
- **A cap on the state.** It loses data, or it changes what the reader keeps when the input grows (elt ADR 0035 rejected caps for this reason).
- **Sync reads after a load of every value at the claim.** It holds the whole state in memory at each claim, as elt does since ADR 0035 ("The extract keeps the entries in memory for the read"). Flink's RocksDB backend, Kafka Streams and Spark read a key when they are asked.
- **The words of Flink (`put`, `remove`, `contains`).** The JavaScript `Map` has the same operations under the names that each reader of TypeScript knows.
- **Named map states, async reads, changes written at the commit.** This option was selected.

## Consequences

- elt's spaces (`crawl`, `diff`, `diff:unknown`, `diff:listed`) become map states with the same names. Its puts and removes become `set` and `delete` on the map state, in place of the `entries` of a `STATE` message.
- A store keeps one row for each partition, state name and key.

## Confirmation

- Survey C (Flink c, Kafka Streams c, Spark c, Airbyte c, Singer c), 2026-11-27.
- elt ADR 0035, its Confirmation: a live crawl of 10,913 URLs wrote a median of 1,507 bytes for each save with keyed entries, against a save of one value that grew by 745 bytes for each page (#4468, elt c76be0c5).
