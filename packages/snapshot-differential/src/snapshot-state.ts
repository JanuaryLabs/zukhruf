import type { KeyValue } from './deletion-policy.ts';
import { isPlainObject } from './fingerprint.ts';

// What the last committed scan saw of one key: the fingerprint of its record,
// or, when the snapshot keeps expiry, the fingerprint and the record's
// expiresBy timestamp.
export type SavedEntry =
  string | readonly [fingerprint: string, expiresBy: string];

// Each key (the JSON of its primary key values, see keyOf) mapped to what the last
// committed scan saw of it. Keys judged unknown stay here too. While a scan
// in parts is open, listed holds the keys its earlier parts listed.
export type SnapshotState = {
  readonly snapshot: Readonly<Record<string, SavedEntry>>;
  readonly listed?: readonly string[];
};

export type SavedGroup = {
  readonly fingerprint: string | null;
  readonly snapshot: Readonly<Record<string, SavedEntry>>;
};

// A key that belongs to no group: one the policy judged unknown, or, while a
// scan in parts is open, one that waits for its last part's judgment. holder
// is the group that held a waiting key, which the deletion policy is told.
export type UnknownEntry = {
  readonly saved: SavedEntry;
  readonly holder?: string;
};

// What the last committed grouped scan saw, as three keyed collections: each
// group's input fingerprint and the snapshot of the records it produced, the
// keys that belong to no group, and, while a scan in parts is open, the
// groups its earlier parts listed.
export type GroupedSnapshot = {
  readonly groups: ReadonlyMap<string, SavedGroup>;
  readonly unknown: ReadonlyMap<string, UnknownEntry>;
  readonly listed: ReadonlySet<string>;
};

// What one diff changed in one keyed collection: the entries to save under
// their keys, and the keys to delete.
export type KeyedChanges<Value> = {
  readonly put: ReadonlyMap<string, Value>;
  readonly remove: ReadonlySet<string>;
};

// What one diff changed in each collection of a grouped snapshot. A listed
// group is saved as true under its key.
export type GroupedSnapshotChanges = {
  readonly groups: KeyedChanges<SavedGroup>;
  readonly unknown: KeyedChanges<UnknownEntry>;
  readonly listed: KeyedChanges<true>;
};

// What the state change of a grouped diff gives: the new snapshot, for the
// next diff in memory, and what changed since the snapshot the diff got, for
// a store that saves each entry under its key.
export type GroupedSnapshotState = {
  readonly snapshot: GroupedSnapshot;
  readonly changes: GroupedSnapshotChanges;
};

// The previous snapshot and the keys the open scan's earlier parts listed,
// as diff wrote them. null when there is none.
export function readSnapshot(
  name: string,
  state: unknown,
): { snapshot: Map<string, SavedEntry>; listed: Set<string> } {
  if (state === null) return { snapshot: new Map(), listed: new Set() };
  if (!isPlainObject(state)) throw invalid(name);
  return {
    snapshot: entries(name, state.snapshot),
    listed: listedKeys(name, state.listed),
  };
}

// A grouped snapshot from the entries a store saved of each collection, as
// the changes of diffGroups gave them. Each group keeps the snapshot object
// the store gives, so a snapshot as large as a mailbox is not copied. A
// holder names a group of the snapshot, since an open scan keeps every group
// until its last part. A listed group need not be in groups: a failed group
// that the snapshot does not have is listed and keeps nothing.
export function readGroups(
  name: string,
  saved: {
    readonly groups: ReadonlyMap<string, unknown>;
    readonly unknown: ReadonlyMap<string, unknown>;
    readonly listed: ReadonlyMap<string, unknown>;
  },
): GroupedSnapshot {
  const groups = new Map<string, SavedGroup>();
  for (const [key, group] of saved.groups) {
    if (
      !isPlainObject(group) ||
      (group.fingerprint !== null && typeof group.fingerprint !== 'string') ||
      !isSnapshot(group.snapshot)
    )
      throw invalid(name);
    groups.set(key, {
      fingerprint: group.fingerprint,
      snapshot: group.snapshot,
    });
  }
  const unknown = new Map<string, UnknownEntry>();
  for (const [key, entry] of saved.unknown) {
    if (
      !isPlainObject(entry) ||
      !isSavedEntry(entry.saved) ||
      (entry.holder !== undefined &&
        (typeof entry.holder !== 'string' || !groups.has(entry.holder)))
    )
      throw invalid(name);
    unknown.set(
      key,
      entry.holder === undefined
        ? { saved: entry.saved }
        : { saved: entry.saved, holder: entry.holder },
    );
  }
  const listed = new Set<string>();
  for (const [key, value] of saved.listed) {
    if (value !== true) throw invalid(name);
    listed.add(key);
  }
  return { groups, unknown, listed };
}

// Sorted by key, so equal scans save byte-identical state.
export function sorted<Value>(
  values: ReadonlyMap<string, Value>,
): Record<string, Value> {
  return Object.fromEntries([...values].sort(([a], [b]) => compareKeys(a, b)));
}

// By UTF-16 code unit, not by locale, so the order never varies by machine.
function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function fingerprintIn(entry: SavedEntry): string {
  return typeof entry === 'string' ? entry : entry[0];
}

// A key value as the JSON of a key holds it. Bytes and a bigint are objects,
// and no other key value is one, so no string key has the form of either.
type SavedKeyValue =
  | string
  | number
  | boolean
  | { readonly bytes: string }
  | { readonly bigint: string };

// The JSON array of a record's primary key values.
export function keyOf(values: readonly KeyValue[]): string {
  return JSON.stringify(
    values.map((value): SavedKeyValue => {
      if (value instanceof Uint8Array)
        return {
          bytes: value.toBase64({ alphabet: 'base64url', omitPadding: true }),
        };
      if (typeof value === 'bigint') return { bigint: String(value) };
      return value;
    }),
  );
}

// The primary key values of a key that keyOf wrote.
export function keyValuesOf(key: string): KeyValue[] {
  const values: SavedKeyValue[] = JSON.parse(key);
  return values.map((value) => {
    if (typeof value !== 'object') return value;
    return 'bytes' in value
      ? Uint8Array.fromBase64(value.bytes, { alphabet: 'base64url' })
      : BigInt(value.bigint);
  });
}

function entries(name: string, snapshot: unknown): Map<string, SavedEntry> {
  if (!isPlainObject(snapshot)) throw invalid(name);
  const saved = new Map<string, SavedEntry>();
  for (const [key, entry] of Object.entries(snapshot)) {
    if (!isSavedEntry(entry)) throw invalid(name);
    saved.set(key, entry);
  }
  return saved;
}

function isSnapshot(value: unknown): value is Record<string, SavedEntry> {
  return isPlainObject(value) && Object.values(value).every(isSavedEntry);
}

function listedKeys(name: string, listed: unknown): Set<string> {
  if (listed === undefined) return new Set();
  if (!Array.isArray(listed) || !listed.every((key) => typeof key === 'string'))
    throw invalid(name);
  return new Set(listed);
}

function isSavedEntry(value: unknown): value is SavedEntry {
  return (
    typeof value === 'string' ||
    (Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string')
  );
}

function invalid(name: string): TypeError {
  return new TypeError(`Snapshot ${name} state is not a saved snapshot`);
}
