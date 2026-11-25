import type {
  DeletionPolicy,
  KeyValue,
  VanishedRecord,
} from './deletion-policy.ts';
import { fingerprintOf } from './fingerprint.ts';
import {
  type GroupedSnapshot,
  type GroupedSnapshotState,
  type KeyedChanges,
  type SavedEntry,
  type SavedGroup,
  type SnapshotState,
  type UnknownEntry,
  fingerprintIn,
  keyOf,
  keyValuesOf,
  readGroups,
  readSnapshot,
  sorted,
} from './snapshot-state.ts';
import { isTimestamp } from './timestamp.ts';

export type SnapshotDifferentialOptions<Data> = {
  // Names the snapshot in errors.
  readonly name: string;
  readonly primaryKey: readonly string[];
  // A record's primary key values, in primaryKey order.
  readonly key: (record: Data) => readonly KeyValue[];
  // The field holding the timestamp at which the upstream drops a record,
  // kept with its key for the policy to read.
  readonly expiresBy?: string | undefined;
  readonly policy: DeletionPolicy;
  // A record's fingerprint, when the caller knows a better one, such as one
  // hash for each field so that an update can name what changed. The default
  // is the SHA-256 of the record's canonical form.
  readonly fingerprint?: (record: Data) => string;
};

// The records one input produced (a file, a message), keyed by that input,
// with a fingerprint the source computes without reading the input.
export type SnapshotGroup<Data> = {
  readonly key: string;
  // null when the source cannot vouch for the input: it is always read.
  readonly fingerprint: string | null;
  records(): AsyncIterable<Data> | Iterable<Data>;
};

// A group the scan lists without reading, because the source vouches that
// its input did not change. It keeps its saved fingerprint and records.
export type KeptGroup = {
  readonly key: string;
  readonly kept: true;
};

// A group whose input the source could not read in this scan, such as a page
// that answered 503 or a file it could not open. It keeps what the snapshot
// has of it, so its keys neither vanish nor expire until a scan reads it,
// apart from a record that another group of the scan gives, which moved; a
// group the snapshot does not have keeps nothing.
export type FailedGroup = {
  readonly key: string;
  readonly failed: true;
};

export type SnapshotChange<Data, State> =
  | { readonly type: 'insert'; readonly record: Data }
  | {
      readonly type: 'update';
      readonly record: Data;
      // The fingerprint that the snapshot saved for the record's key.
      readonly savedFingerprint: string;
    }
  | {
      readonly type: 'delete';
      readonly key: Readonly<Record<string, KeyValue>>;
    }
  | { readonly type: 'state'; readonly state: State };

// A snapshot differential (Labio and Garcia-Molina, VLDB 1996): change data
// capture for an upstream with no change log. It compares one complete scan
// with the previous snapshot and yields an insert for each record whose key
// the snapshot does not have, an update for each record whose key it has with
// another fingerprint, a delete for each key the policy judges deleted, and
// the new snapshot last. An empty
// scan judges every key, so a failed read must throw, never yield nothing.
export class SnapshotDifferential<Data extends Record<string, unknown>> {
  readonly name: string;
  readonly primaryKey: readonly string[];
  readonly expiresBy: string | undefined;
  readonly policy: DeletionPolicy;
  readonly #key: (record: Data) => readonly KeyValue[];
  readonly #fingerprint: (record: Data) => string;

  constructor({
    name,
    primaryKey,
    key,
    expiresBy,
    policy,
    fingerprint = (record) => fingerprintOf(name, record),
  }: SnapshotDifferentialOptions<Data>) {
    this.name = name;
    this.primaryKey = primaryKey;
    this.#key = key;
    this.#fingerprint = fingerprint;
    this.expiresBy = expiresBy;
    this.policy = policy;
  }

  // rereads names the lookback window: a scan the next one repeats only in
  // part, such as days an upstream may still restate. Only records the next
  // scan reads again stay in the snapshot; one left out is never deleted.
  // continues makes this call one part of a scan that later calls go on
  // with, for an upstream that cannot list everything at once: the part
  // judges no vanished key and saves the keys it listed, and the part that
  // ends the scan judges every saved key that no part listed.
  async *diff(
    records: AsyncIterable<Data> | Iterable<Data>,
    state: unknown,
    {
      rereads,
      continues = false,
    }: {
      readonly rereads?: (record: Data) => boolean;
      readonly continues?: boolean;
    } = {},
  ): AsyncGenerator<SnapshotChange<Data, SnapshotState>> {
    const { snapshot: previous, listed } = readSnapshot(this.name, state);
    const seen = new Set<string>();
    const current = new Map<string, SavedEntry>();
    for await (const record of records) {
      const key = this.#claim(seen, record);
      const fingerprint = this.#fingerprint(record);
      if (rereads?.(record) ?? true)
        current.set(key, this.#entry(record, fingerprint));
      const before = previous.get(key);
      if (before === undefined) yield { type: 'insert', record };
      else if (fingerprintIn(before) !== fingerprint)
        yield {
          type: 'update',
          record,
          savedFingerprint: fingerprintIn(before),
        };
    }
    const listedSoFar = listed.union(seen);
    for (const [key, entry] of previous)
      if (!seen.has(key) && (continues || listed.has(key)))
        current.set(key, entry);
    if (continues) {
      yield {
        type: 'state',
        state: {
          snapshot: sorted(current),
          listed: [...listedSoFar].sort(),
        },
      };
      return;
    }
    yield* this.#judge(previous, listedSoFar, (key, entry) =>
      current.set(key, entry),
    );
    yield { type: 'state', state: { snapshot: sorted(current) } };
  }

  // The grouped snapshot before the first scan: a new one at each read, so
  // a caller that changes one changes no other caller's snapshot.
  static get noGroups(): GroupedSnapshot {
    return { groups: new Map(), unknown: new Map(), listed: new Set() };
  }

  // The grouped snapshot that a store saved, from the entries it saved of
  // each collection: each change of diffGroups applied in order.
  savedGroups(saved: {
    readonly groups: ReadonlyMap<string, unknown>;
    readonly unknown: ReadonlyMap<string, unknown>;
    readonly listed: ReadonlyMap<string, unknown>;
  }): GroupedSnapshot {
    return readGroups(this.name, saved);
  }

  // diff for a scan whose records come from inputs the source fingerprints
  // cheaply. A group whose fingerprint matches the last committed scan, a
  // kept group and a failed group keep their records without reading them;
  // every other group is read and diffed record by record. Vanished keys are
  // judged over the complete scan. continues makes this call one part of a
  // scan in parts, as for diff. The state change gives the new snapshot and
  // what changed in it, so a store saves only the entries that changed.
  async *diffGroups(
    groups:
      | AsyncIterable<SnapshotGroup<Data> | KeptGroup | FailedGroup>
      | Iterable<SnapshotGroup<Data> | KeptGroup | FailedGroup>,
    snapshot: GroupedSnapshot,
    { continues = false }: { readonly continues?: boolean } = {},
  ): AsyncGenerator<SnapshotChange<Data, GroupedSnapshotState>> {
    // Every saved entry by key, so a record that moves between groups or
    // comes back from unknown is compared with its previous fingerprint.
    const saved = new Map<string, SavedEntry>();
    // The group that held each saved key, for the policy's judgment, also of
    // a key that vanished in an earlier part of an open scan.
    const holders = new Map<string, string>();
    for (const [key, { saved: entry, holder }] of snapshot.unknown) {
      saved.set(key, entry);
      if (holder !== undefined) holders.set(key, holder);
    }
    for (const [groupKey, { snapshot: records }] of snapshot.groups)
      for (const [key, entry] of Object.entries(records)) {
        saved.set(key, entry);
        holders.set(key, groupKey);
      }
    const seen = new Set<string>();
    const current = new Map<string, SavedGroup>();
    // The groups this call failed to read: listed, and kept as the groups an
    // open scan has not reached are, after the groups it read.
    const failed = new Set<string>();
    for await (const group of groups) {
      if (current.has(group.key) || failed.has(group.key))
        throw new TypeError(
          `Snapshot ${this.name} returned group ${group.key} twice in one scan`,
        );
      if ('failed' in group) {
        failed.add(group.key);
        continue;
      }
      const before = snapshot.groups.get(group.key);
      if (
        'kept' in group ||
        (group.fingerprint !== null &&
          before?.fingerprint === group.fingerprint)
      ) {
        if (before === undefined)
          throw new TypeError(
            `Snapshot ${this.name} kept group ${group.key}, which its snapshot does not have`,
          );
        for (const key of Object.keys(before.snapshot))
          this.#claimKey(seen, key);
        current.set(group.key, before);
        continue;
      }
      const records = new Map<string, SavedEntry>();
      for await (const record of group.records()) {
        const key = this.#claim(seen, record);
        const fingerprint = this.#fingerprint(record);
        records.set(key, this.#entry(record, fingerprint));
        const before = saved.get(key);
        if (before === undefined) yield { type: 'insert', record };
        else if (fingerprintIn(before) !== fingerprint)
          yield {
            type: 'update',
            record,
            savedFingerprint: fingerprintIn(before),
          };
      }
      current.set(group.key, {
        fingerprint: group.fingerprint,
        snapshot: sorted(records),
      });
    }
    const listed = new Set([...current.keys(), ...failed]);
    // A group this call did not read keeps what the scan saw of it while the
    // scan goes on, when an earlier part listed it, or when this call failed
    // to read it; a record that moved into a group this call read leaves it.
    for (const [key, before] of snapshot.groups) {
      if (
        current.has(key) ||
        !(continues || snapshot.listed.has(key) || failed.has(key))
      )
        continue;
      const all = Object.entries(before.snapshot);
      const records = all.filter(([recordKey]) => !seen.has(recordKey));
      for (const [recordKey] of records) seen.add(recordKey);
      // A group that no record left keeps its object, so the changes do not
      // put it.
      current.set(
        key,
        records.length === all.length
          ? before
          : {
              fingerprint: before.fingerprint,
              snapshot: Object.fromEntries(records),
            },
      );
    }
    const unknown = new Map<string, UnknownEntry>();
    // An unchanged entry keeps its object, so the changes do not put it.
    const keep = (key: string, entry: SavedEntry, holder?: string) => {
      const before = snapshot.unknown.get(key);
      unknown.set(
        key,
        before?.saved === entry && before.holder === holder
          ? before
          : holder === undefined
            ? { saved: entry }
            : { saved: entry, holder },
      );
    };
    if (continues) {
      // A key no group holds any more, such as one that vanished from a
      // group this part read again, waits for the last part's judgment.
      const grouped = new Set(
        [...current.values()].flatMap(({ snapshot }) => Object.keys(snapshot)),
      );
      for (const [key, entry] of saved)
        if (!seen.has(key) && !grouped.has(key))
          keep(key, entry, holders.get(key));
    } else {
      yield* this.#judge(saved, seen, keep, (key) => {
        const holder = holders.get(key);
        return holder === undefined
          ? undefined
          : {
              key: holder,
              listed: snapshot.listed.has(holder) || listed.has(holder),
            };
      });
    }
    const listedSoFar = continues
      ? snapshot.listed.union(listed)
      : new Set<string>();
    yield {
      type: 'state',
      state: {
        snapshot: { groups: current, unknown, listed: listedSoFar },
        changes: {
          groups: changesOf(snapshot.groups, current),
          unknown: changesOf(snapshot.unknown, unknown),
          listed: {
            put: new Map(
              [...listedSoFar.difference(snapshot.listed)].map((key) => [
                key,
                true,
              ]),
            ),
            remove: snapshot.listed.difference(listedSoFar),
          },
        },
      },
    };
  }

  // Asks the policy about every saved key the scan did not list. A deleted
  // one yields a delete, an unknown one is given to keep, an expired one
  // leaves.
  *#judge(
    saved: ReadonlyMap<string, SavedEntry>,
    seen: ReadonlySet<string>,
    keep: (key: string, entry: SavedEntry) => void,
    groupOf: (key: string) => VanishedRecord['group'] = () => undefined,
  ): Generator<SnapshotChange<Data, never>> {
    for (const [key, entry] of saved) {
      if (seen.has(key)) continue;
      const group = groupOf(key);
      const record: VanishedRecord = {
        key: this.#keyObject(key),
        ...(typeof entry === 'string' ? {} : { expiresBy: entry[1] }),
        ...(group === undefined ? {} : { group }),
      };
      const verdict = this.policy.vanished(record);
      if (verdict === 'deleted') yield { type: 'delete', key: record.key };
      else if (verdict === 'unknown') keep(key, entry);
    }
  }

  #claim(seen: Set<string>, record: Data): string {
    const key = keyOf(this.#key(record));
    this.#claimKey(seen, key);
    return key;
  }

  #claimKey(seen: Set<string>, key: string): void {
    if (seen.has(key))
      throw new TypeError(
        `Snapshot ${this.name} returned ${this.#keyText(key)} twice in one scan`,
      );
    seen.add(key);
  }

  #entry(record: Data, fingerprint: string): SavedEntry {
    if (this.expiresBy === undefined) return fingerprint;
    const expiresBy = record[this.expiresBy];
    if (!isTimestamp(expiresBy))
      throw new TypeError(
        `Snapshot ${this.name} records must carry ${this.expiresBy} as a timestamp to expire`,
      );
    return [fingerprint, expiresBy];
  }

  // A key as its primary key fields, from the JSON of its values.
  #keyObject(key: string): Record<string, KeyValue> {
    const values = keyValuesOf(key);
    return Object.fromEntries(
      this.primaryKey.map((field, index) => {
        const value = values[index];
        if (value === undefined)
          throw new TypeError(
            `Snapshot key ${key} does not match ${this.name}'s primary key`,
          );
        return [field, value];
      }),
    );
  }

  // A key as people read it: each field with its value, a string as it is
  // and bytes in hex.
  #keyText(key: string): string {
    return Object.entries(this.#keyObject(key))
      .map(([field, value]) => `${field} ${valueText(value)}`)
      .join(', ');
  }
}

// The entries of after that are not the same object in before, and the keys
// of before that after does not have.
function changesOf<Value>(
  before: ReadonlyMap<string, Value>,
  after: ReadonlyMap<string, Value>,
): KeyedChanges<Value> {
  return {
    put: new Map(
      [...after].filter(([key, value]) => before.get(key) !== value),
    ),
    remove: new Set([...before.keys()].filter((key) => !after.has(key))),
  };
}

function valueText(value: KeyValue): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return `bytes ${value.toHex()}`;
  if (typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}
