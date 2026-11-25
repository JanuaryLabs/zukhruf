# @zukhruf/snapshot-differential

An upstream with no change log, such as the SQLite store of a desktop app, can give only a list of its records. To load only what changed, you compare each new list with the last one. This package does that comparison: it is a snapshot differential (Labio and Garcia-Molina, "Efficient Snapshot Differential Algorithms for Data Warehousing", VLDB 1996), also known as change data capture by diff compare. A record that is not in the new list is not always deleted. A cache holds only part of its records, and an upstream with a time to live drops old records. Thus a deletion policy judges each such key.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @zukhruf/snapshot-differential
```

This program diffs two scans of contacts. It saves the snapshot of the first scan and gives it to the diff of the second scan:

```ts title="use-it.ts"
import {
  ClosedWorld,
  SnapshotDifferential,
  type SnapshotState,
} from '@zukhruf/snapshot-differential';

type Contact = { id: string; name: string };

const contacts = new SnapshotDifferential<Contact>({
  name: 'contacts',
  primaryKey: ['id'],
  key: (contact) => [contact.id],
  policy: new ClosedWorld(),
});

let saved: SnapshotState | null = null;
const scans: Contact[][] = [
  [
    { id: '1', name: 'Ada' },
    { id: '2', name: 'Grace' },
  ],
  [
    { id: '1', name: 'Ada Lovelace' },
    { id: '3', name: 'Edsger' },
  ],
];
for (const scan of scans) {
  for await (const change of contacts.diff(scan, saved)) {
    if (change.type === 'state') saved = change.state;
    else if (change.type === 'delete') console.log('delete', change.key);
    else console.log(change.type, change.record);
  }
}
```

Output:

```
insert { id: '1', name: 'Ada' }
insert { id: '2', name: 'Grace' }
update { id: '1', name: 'Ada Lovelace' }
insert { id: '3', name: 'Edsger' }
delete { id: '2' }
```

## A diff yields the changes, then the snapshot

Make one `SnapshotDifferential` for each scan. Give it the primary key fields, a function that gives the primary key values of a record in the same order, and a deletion policy. Then give `diff` the scan and the snapshot that the last committed scan saved:

```ts
import {
  ClosedWorld,
  SnapshotDifferential,
} from '@zukhruf/snapshot-differential';

type Contact = { id: string; name: string };

const differential = new SnapshotDifferential<Contact>({
  name: 'contacts',
  primaryKey: ['id'],
  key: (contact) => [contact.id],
  policy: new ClosedWorld(),
});
for await (const change of differential.diff(contacts, saved)) {
  if (change.type === 'insert') await insert(change.record);
  else if (change.type === 'update') await update(change.record);
  else if (change.type === 'delete') await remove(change.key);
  else await save(change.state);
}
```

- Give `null` as the snapshot for the first scan.
- The diff yields an insert for each record whose key the snapshot does not have.
- The diff yields an update for each record whose key the snapshot has with a different fingerprint. The update has `savedFingerprint`, the fingerprint that the snapshot saved for the key.
- The diff yields nothing for a record that did not change.
- The diff yields the new snapshot last. Save it only after you applied the changes before it.
- Equal scans give byte-identical snapshots, in any order of records.
- A failed read must throw. An empty scan makes every key a vanished key.

## You can give the fingerprint

By default, a record's fingerprint is the SHA-256 of its canonical form. Give `fingerprint` when you know a better one, for example one hash for each field, so that an update can name the fields that changed:

```ts
const rows = new SnapshotDifferential<Row>({
  name: 'rows',
  primaryKey: ['id'],
  key: (row) => [row.id],
  fingerprint: (row) => hashOfEachField(row),
  policy: new ClosedWorld(),
});

for await (const change of rows.diff(records, state))
  if (change.type === 'update')
    compare(change.savedFingerprint, hashOfEachField(change.record));
```

- The diff compares the fingerprints that your function gives. Two records with the same fingerprint are the same record to the diff.
- `@zukhruf/sqlite-changefeed` gives one 8-byte hash for each column, and names the changed columns of each update.

See [ADR 0008](./docs/adr/0008-the-caller-can-give-the-fingerprint.md).

## A deletion policy judges each vanished key

A vanished key is a key that the snapshot has and the scan does not list. The diff asks the policy about each one, and the policy gives one verdict:

| Verdict   | Meaning                                                                    | The diff                                       |
| --------- | -------------------------------------------------------------------------- | ---------------------------------------------- |
| `deleted` | The upstream deleted the record (the closed-world assumption).             | Yields a delete. The key leaves the snapshot.  |
| `unknown` | The scan cannot tell (the open-world assumption).                          | Yields nothing. The key stays in the snapshot. |
| `expired` | The upstream dropped the record for good, with no deletion, as a TTL does. | Yields nothing. The key leaves the snapshot.   |

The package has three policies:

- `ClosedWorld`: the scan lists every record, so each vanished key was deleted.
- `Retention(horizon)`: the upstream keeps records from the horizon on. A key whose expiry is before the horizon expired. Each other key was deleted. Give the differential the `expiresBy` field, so that the snapshot keeps the expiry of each key.
- `Coverage(covers)`: the upstream holds only part of its records, as a cache does. A vanished key that `covers` accepts was deleted. Each other key is unknown.

To judge keys in a different way, write a subclass of `DeletionPolicy`:

```ts
import {
  DeletionPolicy,
  type VanishedRecord,
  type Verdict,
} from '@zukhruf/snapshot-differential';

// The app keeps a channel's messages only while the channel is open.
class OpenChannels extends DeletionPolicy {
  readonly open: ReadonlySet<string>;

  constructor(open: ReadonlySet<string>) {
    super();
    this.open = open;
  }

  override vanished({ key }: VanishedRecord): Verdict {
    return this.open.has(String(key.channel)) ? 'deleted' : 'unknown';
  }
}
```

In a grouped scan, a vanished key also names the group that held it in the last committed scan, and whether the scan listed that group, also when an earlier part of a scan in parts listed it ([ADR 0009](./docs/adr/0009-a-vanished-key-names-the-group-that-held-it.md)). A source whose groups are complete partitions, such as the pages of a web crawl, deletes a key that vanished from a group it listed again and lets the key of a group it did not list expire:

```ts
class ListedGroups extends DeletionPolicy {
  override vanished({ group }: VanishedRecord): Verdict {
    return group?.listed === true ? 'deleted' : 'expired';
  }
}
```

## An unknown key stays until a scan can tell

The policy judges an unknown key again at each scan:

- When a later scan covers the key and does not list it, the verdict is `deleted`, and the diff yields a delete.
- When a later scan lists the record again with the same fingerprint, the diff yields nothing.
- When a later scan lists the record again with a different fingerprint, the diff yields an update, because the snapshot has the key ([ADR 0005](./docs/adr/0005-a-change-is-an-insert-or-an-update.md)).

For example, a chat app drops a thread from its cache. Then a reply in that thread is deleted. Then the app loads the thread again. The reply is not in the thread, and the scan covers it, so the diff deletes it.

The snapshot keeps each unknown key. Thus the snapshot grows with the records that the upstream holds no more and that no scan can judge.

## A group with the same fingerprint is not read

When a scan comes from inputs that you can fingerprint cheaply, such as files by their size and time, give `diffGroups` one group for each input:

```ts
for await (const change of differential.diffGroups(
  files.map((file) => ({
    key: file.path,
    fingerprint: `${file.size}:${file.mtimeMs}`,
    records: () => parse(file.path),
  })),
  saved,
)) {
  // …
}
```

- A group with the same fingerprint as in the snapshot keeps its records. The diff does not call its `records`.
- A group with a `null` fingerprint is always read.
- A kept group, `{ key, kept: true }`, keeps its saved fingerprint and records. Give it when you know that the input did not change but you cannot fingerprint it, such as a page that a crawl did not request. A kept group that the snapshot does not have is an error ([ADR 0004](./docs/adr/0004-a-scan-can-keep-a-group-without-reading-it.md)).
- A record that moves to a different group, with the same fingerprint, gets no change. With a different fingerprint, it gets an update.
- The policy judges the vanished keys of the complete scan, also the keys of groups that are not in the scan.

## A lookback window keeps only what the next scan reads again

Some scans read a window, and the next scan reads only part of it again, such as the days that an upstream can still restate. Give `diff` a `rereads` function. Only the records that it accepts stay in the snapshot. A record outside the window leaves the snapshot, and the diff never deletes it.

```ts
differential.diff(days, saved, {
  rereads: (day) => day.date >= settled,
});
```

## A scan in parts deletes only at its last part

Some upstreams cannot list all their records in one call: an API that pages slowly and stops a client that reads too much. Give `diff` or `diffGroups` the option `continues: true` for each call that lists one part of the scan, and leave it out for the call that lists the last part:

```ts
for await (const page of profile.pages(after)) {
  for await (const change of differential.diff(page.posts, saved, {
    continues: page.hasNext,
  })) {
    // …
  }
}
```

- A part yields an insert or an update for each new or changed record that it lists. It does not wait for the last part.
- A part that continues the scan judges no vanished key. Its snapshot keeps every key, and the keys that the open scan listed so far.
- The last part judges each saved key that no part of the scan listed.
- In `diffGroups`, a record that leaves a group that a part reads again waits in the snapshot for the last part's judgment.
- Two parts can list the same key. One part cannot list a key twice.
- The parts can be in different runs. Save the snapshot after each part, and give it to the next part.
- The next scan starts with no listed keys.

## A record and a key can hold bytes

A `Uint8Array` is bytes, and a `Buffer` is a `Uint8Array`. A `BLOB` column of SQLite gives bytes. A record can hold bytes at any depth, and a key value can be bytes:

```ts
type Attachment = { id: Uint8Array; body: Uint8Array };

const attachments = new SnapshotDifferential<Attachment>({
  name: 'attachments',
  primaryKey: ['id'],
  key: (attachment) => [attachment.id],
  policy: new ClosedWorld(),
});
```

- Equal bytes give equal fingerprints, in a `Buffer` or in a `Uint8Array`, and also in a view of a larger buffer.
- Bytes and a string or an array of numbers with the same content give different fingerprints.
- The snapshot keeps a key value of bytes as `{"bytes": "<base64url>"}`. Only bytes and a `bigint` are objects in a key, so no string key has this form.
- A delete gives a key value of bytes back as a `Uint8Array`.
- Other typed arrays, such as `Uint16Array`, are not bytes. A record that holds one fails.

See [ADR 0006](./docs/adr/0006-a-record-and-a-key-can-hold-bytes.md).

## A record and a key can hold a bigint

A number holds an integer exactly only up to 2^53. An `INTEGER` of SQLite holds 64 bits, and `node:sqlite` gives it as a `bigint` with `readBigInts`. A record can hold a `bigint` at any depth, and a key value can be a `bigint`:

```ts
type Visit = { id: bigint; task: bigint };

const visits = new SnapshotDifferential<Visit>({
  name: 'visits',
  primaryKey: ['id'],
  key: (visit) => [visit.id],
  policy: new ClosedWorld(),
});
```

- Equal bigints give equal fingerprints. `5n` and `5` give different fingerprints.
- The snapshot keeps a key value that is a `bigint` as `{"bigint": "<digits>"}`.
- A delete gives a key value that is a `bigint` back as a `bigint`.

See [ADR 0007](./docs/adr/0007-a-record-and-a-key-can-hold-a-bigint.md).

## Errors

Each failure is a `TypeError`. A diff that fails yields no snapshot. The tests in `src/snapshot-differential.test.ts` check each message but the one of a saved key that does not match the primary key (`src/snapshot-differential.ts`, `#keyObject`).

| Error       | When                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TypeError` | One call lists one key twice: `Snapshot <name> returned <key> twice in one scan`. In a scan in parts, this applies to each part.                                                                                                                                                                                                                                                           |
| `TypeError` | `diffGroups` gets one group key twice: `Snapshot <name> returned group <key> twice in one scan`.                                                                                                                                                                                                                                                                                           |
| `TypeError` | `diffGroups` gets a kept group that the snapshot does not have: `Snapshot <name> kept group <key>, which its snapshot does not have` ([ADR 0004](./docs/adr/0004-a-scan-can-keep-a-group-without-reading-it.md)).                                                                                                                                                                          |
| `TypeError` | A record has a value that JSON cannot hold without a change and that is not bytes or a `bigint`, such as `undefined`, a `Date`, a `Map`, an instance of a class or a `Uint16Array`: `Snapshot <name> records must be losslessly JSON serializable, or bytes, to diff snapshots`. An object with a `null` prototype, such as a row from `node:sqlite`, is a plain object and does not fail. |
| `TypeError` | A record has no timestamp in its `expiresBy` field, in the format of `Date#toISOString`: `Snapshot <name> records must carry <field> as a timestamp to expire`.                                                                                                                                                                                                                            |
| `TypeError` | The saved state is not a snapshot that this package wrote: `Snapshot <name> state is not a saved snapshot`.                                                                                                                                                                                                                                                                                |
| `TypeError` | A vanished key of the saved snapshot has fewer values than `primaryKey` has fields, such as a key saved before a field was added to `primaryKey`: `Snapshot key <key> does not match <name>'s primary key`.                                                                                                                                                                                |
| `TypeError` | `Retention` gets a horizon that is not a timestamp: `Retention horizon <horizon> is not a timestamp`.                                                                                                                                                                                                                                                                                      |

## The same concepts in other systems

| This package             | Other systems                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot differential    | Labio and Garcia-Molina, VLDB 1996; change data capture by diff compare in Kimball and Caserta, _The Data Warehouse ETL Toolkit_ |
| `DeletionPolicy`         | The Strategy pattern of Gamma et al., _Design Patterns_, which also names it Policy                                              |
| `deleted`, `ClosedWorld` | The closed-world assumption of Reiter, "On Closed World Data Bases" (1978)                                                       |
| `unknown`, `Coverage`    | The open-world assumption                                                                                                        |
| `expired`, `Retention`   | Cassandra's TTL; Kafka's `retention.ms`                                                                                          |
| `rereads`                | The lookback of dbt incremental models; the re-sync window of Fivetran                                                           |
| `continues`              | The incremental marking of a mark-and-sweep garbage collector: each part marks, and the last part sweeps                         |
| Groups and fingerprints  | The up-to-date checks of Make and Bazel                                                                                          |

Airbyte has no equivalent. Outside change data capture, it deletes only when it replaces a complete stream, and its state decides what to read again, never what to delete.

## API

```ts
type KeyValue = string | number | bigint | boolean | Uint8Array;

type VanishedRecord = {
  readonly key: Readonly<Record<string, KeyValue>>;
  readonly expiresBy?: string; // only when the differential has expiresBy
  // only in a grouped scan, for a key a group held: that group, and whether the scan listed it
  readonly group?: { readonly key: string; readonly listed: boolean };
};

type Verdict = 'deleted' | 'unknown' | 'expired';

abstract class DeletionPolicy {
  abstract vanished(record: VanishedRecord): Verdict;
}

class ClosedWorld extends DeletionPolicy {} // each vanished key: 'deleted'

class Retention extends DeletionPolicy {
  constructor(horizon: string); // TypeError: unless a Date#toISOString timestamp
  readonly horizon: string;
}

class Coverage extends DeletionPolicy {
  constructor(covers: (record: VanishedRecord) => boolean); // false: 'unknown'
}

type SnapshotDifferentialOptions<Data> = {
  readonly name: string; // names the snapshot in errors
  readonly primaryKey: readonly string[];
  readonly key: (record: Data) => readonly KeyValue[]; // in primaryKey order
  readonly expiresBy?: string | undefined; // the field of the record's expiry
  readonly policy: DeletionPolicy;
  readonly fingerprint?: (record: Data) => string; // default: SHA-256 of the canonical form
};

type SnapshotGroup<Data> = {
  readonly key: string;
  readonly fingerprint: string | null; // null: always read
  records(): AsyncIterable<Data> | Iterable<Data>;
};

type KeptGroup = {
  readonly key: string;
  readonly kept: true;
};

type SnapshotChange<Data, State> =
  | { readonly type: 'insert'; readonly record: Data }
  | {
      readonly type: 'update';
      readonly record: Data;
      readonly savedFingerprint: string;
    }
  | {
      readonly type: 'delete';
      readonly key: Readonly<Record<string, KeyValue>>;
    }
  | { readonly type: 'state'; readonly state: State }; // last

type SnapshotState = {
  readonly snapshot: Readonly<Record<string, SavedEntry>>;
  readonly listed?: readonly string[]; // while a scan in parts is open
};

type GroupedSnapshotState = {
  readonly groups: Readonly<Record<string, SavedGroup>>;
  readonly unknown?: Readonly<Record<string, SavedEntry>>;
  readonly listed?: readonly string[]; // while a scan in parts is open
};

class SnapshotDifferential<Data extends Record<string, unknown>> {
  constructor(options: SnapshotDifferentialOptions<Data>);
  readonly name: string;
  readonly primaryKey: readonly string[];
  readonly expiresBy: string | undefined;
  readonly policy: DeletionPolicy;
  diff(
    records: AsyncIterable<Data> | Iterable<Data>,
    state: unknown, // null for the first scan
    options?: {
      readonly rereads?: (record: Data) => boolean;
      readonly continues?: boolean; // default: false
    },
  ): AsyncGenerator<SnapshotChange<Data, SnapshotState>>;
  diffGroups(
    groups:
      | AsyncIterable<SnapshotGroup<Data> | KeptGroup>
      | Iterable<SnapshotGroup<Data> | KeptGroup>,
    state: unknown, // null for the first scan
    options?: { readonly continues?: boolean }, // default: false
  ): AsyncGenerator<SnapshotChange<Data, GroupedSnapshotState>>;
}
```

`SavedEntry` and `SavedGroup` are not exported. Save the state as the diff gives it, and give it back unchanged.

## Documentation

**Recipes**

- [Report only the records that changed since the last check](./docs/recipes/report-only-what-changed-since-the-last-check.md)

**Decisions**

- [ADR 0001: A vanished key is judged by a deletion policy](./docs/adr/0001-a-vanished-key-is-judged-by-a-deletion-policy.md)
- [ADR 0002: A scan can be listed in parts](./docs/adr/0002-a-scan-can-be-listed-in-parts.md)
- [ADR 0003: The differential is a zukhruf package](./docs/adr/0003-the-differential-is-a-zukhruf-package.md)
- [ADR 0004: A scan can keep a group without reading it](./docs/adr/0004-a-scan-can-keep-a-group-without-reading-it.md)
- [ADR 0005: A change is an insert or an update](./docs/adr/0005-a-change-is-an-insert-or-an-update.md)
- [ADR 0006: A record and a key can hold bytes](./docs/adr/0006-a-record-and-a-key-can-hold-bytes.md)
- [ADR 0007: A record and a key can hold a bigint](./docs/adr/0007-a-record-and-a-key-can-hold-a-bigint.md)
- [ADR 0008: The caller can give the fingerprint](./docs/adr/0008-the-caller-can-give-the-fingerprint.md)

## Development

Run the commands from the workspace root.

```sh
npx nx run snapshot-differential:test        # builds, then runs the tests in dist/
npx nx run snapshot-differential:typecheck   # formats, lints, then type checks
```

```
src/
  snapshot-differential.ts   SnapshotDifferential: diff, diffGroups, and the judgment of vanished keys
  snapshot-state.ts          the saved snapshot and its guards
  deletion-policy.ts         DeletionPolicy, VanishedRecord, Verdict
  closed-world.ts            ClosedWorld
  retention.ts               Retention
  coverage.ts                Coverage
  fingerprint.ts             fingerprints over canonical JSON, with bytes
  timestamp.ts               the timestamp check
  index.ts                   the public exports
  snapshot-differential.test.ts   the tests
```
