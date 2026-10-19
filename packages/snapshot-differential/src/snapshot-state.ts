import { isPlainObject } from './fingerprint.ts';

// What the last committed scan saw of one key: the fingerprint of its record,
// or, when the snapshot keeps expiry, the fingerprint and the record's
// expiresBy timestamp.
export type SavedEntry =
  string | readonly [fingerprint: string, expiresBy: string];

// Each key (the JSON of its primary key values) mapped to what the last
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

// Each group's input fingerprint and the snapshot of the records it produced,
// and the keys that belong to no group any more: those judged unknown and,
// while a scan in parts is open, those waiting for its last part's
// judgment. listed holds the groups the open scan's earlier parts listed.
export type GroupedSnapshotState = {
  readonly groups: Readonly<Record<string, SavedGroup>>;
  readonly unknown?: Readonly<Record<string, SavedEntry>>;
  readonly listed?: readonly string[];
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

// The previous groups, unknown keys and the groups the open scan's earlier
// parts listed, as diffGroups wrote them.
export function readGroups(
  name: string,
  state: unknown,
): {
  groups: Map<string, SavedGroup>;
  unknown: Map<string, SavedEntry>;
  listed: Set<string>;
} {
  if (state === null)
    return { groups: new Map(), unknown: new Map(), listed: new Set() };
  if (!isPlainObject(state) || !isPlainObject(state.groups))
    throw invalid(name);
  const groups = new Map<string, SavedGroup>();
  for (const [key, group] of Object.entries(state.groups)) {
    if (
      !isPlainObject(group) ||
      (group.fingerprint !== null && typeof group.fingerprint !== 'string')
    )
      throw invalid(name);
    groups.set(key, {
      fingerprint: group.fingerprint,
      snapshot: Object.fromEntries(entries(name, group.snapshot)),
    });
  }
  return {
    groups,
    unknown:
      state.unknown === undefined ? new Map() : entries(name, state.unknown),
    listed: listedKeys(name, state.listed),
  };
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

export function fingerprintIn(
  entry: SavedEntry | undefined,
): string | undefined {
  return typeof entry === 'string' ? entry : entry?.[0];
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
