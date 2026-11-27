import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import type { SQLOutputValue } from 'node:sqlite';
import { promisify } from 'node:util';

import { test } from '@zukhruf/parameterized-test';
import { open } from '@zukhruf/sqlite-open';

import {
  ClosedWorld,
  Coverage,
  DeletionPolicy,
  type GroupedSnapshot,
  type GroupedSnapshotChanges,
  type KeyedChanges,
  Retention,
  type SnapshotChange,
  SnapshotDifferential,
  type SnapshotGroup,
  type VanishedRecord,
  type Verdict,
} from './index.ts';

const execFileAsync = promisify(execFile);

type Item = { readonly id: string; readonly value: string };

function items(
  policy: DeletionPolicy,
  expiresBy?: string,
): SnapshotDifferential<Item> {
  return new SnapshotDifferential<Item>({
    name: 'items',
    primaryKey: ['id'],
    key: (record) => [record.id],
    expiresBy,
    policy,
  });
}

// The ids one diff inserted, updated and deleted, and the state it saved last.
async function changes<State>(
  diff: AsyncIterable<SnapshotChange<Item, State>>,
): Promise<{
  inserted: string[];
  updated: string[];
  deleted: string[];
  state: State;
}> {
  const inserted: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  const states: State[] = [];
  for await (const change of diff)
    if (change.type === 'insert') inserted.push(change.record.id);
    else if (change.type === 'update') updated.push(change.record.id);
    else if (change.type === 'delete') deleted.push(String(change.key.id));
    else states.push(change.state);
  const [state, ...more] = states;
  assert.ok(state !== undefined && more.length === 0, 'one state, last');
  return { inserted, updated, deleted, state };
}

function group(
  key: string,
  fingerprint: string | null,
  records: readonly Item[],
): SnapshotGroup<Item> {
  return { key, fingerprint, records: () => records };
}

test('a scan inserts the records whose keys the snapshot does not have and updates the changed ones, and an identical rescan yields nothing and saves the same state', async () => {
  const policy = new ClosedWorld();

  const first = await changes(
    items(policy).diff(
      [
        { id: 'a', value: '1' },
        { id: 'b', value: '1' },
      ],
      null,
    ),
  );
  const changed = await changes(
    items(policy).diff(
      [
        { id: 'a', value: '1' },
        { id: 'b', value: '2' },
      ],
      first.state,
    ),
  );
  const again = await changes(
    items(policy).diff(
      [
        { id: 'b', value: '2' },
        { id: 'a', value: '1' },
      ],
      changed.state,
    ),
  );

  assert.deepEqual([first.inserted, first.updated], [['a', 'b'], []]);
  assert.deepEqual([changed.inserted, changed.updated], [[], ['b']]);
  assert.deepEqual([again.inserted, again.updated], [[], []]);
  assert.equal(JSON.stringify(again.state), JSON.stringify(changed.state));
});

test('under the closed-world assumption a key the scan does not list is deleted and leaves the snapshot', async () => {
  const policy = new ClosedWorld();
  const first = await changes(
    items(policy).diff(
      [
        { id: 'a', value: '1' },
        { id: 'b', value: '1' },
      ],
      null,
    ),
  );

  const second = await changes(
    items(policy).diff([{ id: 'a', value: '1' }], first.state),
  );
  const third = await changes(
    items(policy).diff([{ id: 'a', value: '1' }], second.state),
  );

  assert.deepEqual(second.deleted, ['b']);
  assert.deepEqual(third.deleted, []);
  assert.deepEqual(Object.keys(second.state.snapshot), ['["a"]']);
});

test('under retention a key that vanished before the horizon expired and one after it was deleted', async () => {
  type Seen = Item & { readonly seenAt: string };
  const seen = (policy: DeletionPolicy) =>
    new SnapshotDifferential<Seen>({
      name: 'seen',
      primaryKey: ['id'],
      key: (record) => [record.id],
      expiresBy: 'seenAt',
      policy,
    });
  const first = await changes(
    seen(new ClosedWorld()).diff(
      [
        { id: 'old', value: '1', seenAt: '2026-01-01T00:00:00.000Z' },
        { id: 'early', value: '1', seenAt: '2026-01-31T23:59:59.999Z' },
        { id: 'edge', value: '1', seenAt: '2026-02-01T00:00:00.000Z' },
        { id: 'recent', value: '1', seenAt: '2026-03-01T00:00:00.000Z' },
      ],
      null,
    ),
  );

  const second = await changes(
    seen(new Retention('2026-02-01T00:00:00.000Z')).diff([], first.state),
  );

  assert.deepEqual(second.deleted, ['edge', 'recent']);
  assert.deepEqual(second.state.snapshot, {});
  assert.throws(
    () => new Retention('yesterday'),
    /Retention horizon yesterday is not a timestamp/,
  );
  await assert.rejects(
    Array.fromAsync(
      seen(new ClosedWorld()).diff(
        [{ id: 'x', value: '1', seenAt: 'yesterday' }],
        null,
      ),
    ),
    /must carry seenAt as a timestamp to expire/,
  );
});

test('under coverage a key outside what the scan covers stays unknown until a scan covers it, and comes back unchanged without a write', async () => {
  const outside = new Coverage(({ key }) => key.id !== 'b');
  const everything = new Coverage(() => true);
  const first = await changes(
    items(everything).diff(
      [
        { id: 'a', value: '1' },
        { id: 'b', value: '1' },
        { id: 'c', value: '1' },
      ],
      null,
    ),
  );

  // b and c leave the scan; only c is where the scan covers.
  const evicted = await changes(
    items(outside).diff([{ id: 'a', value: '1' }], first.state),
  );
  // b's range comes back without b: it was deleted meanwhile.
  const covered = await changes(
    items(everything).diff([{ id: 'a', value: '1' }], evicted.state),
  );
  // b's range comes back with b as it was.
  const returned = await changes(
    items(everything).diff(
      [
        { id: 'a', value: '1' },
        { id: 'b', value: '1' },
      ],
      evicted.state,
    ),
  );

  assert.deepEqual(evicted.deleted, ['c']);
  assert.deepEqual(Object.keys(evicted.state.snapshot), ['["a"]', '["b"]']);
  assert.deepEqual(covered.deleted, ['b']);
  assert.deepEqual(Object.keys(covered.state.snapshot), ['["a"]']);
  assert.deepEqual([returned.inserted, returned.updated], [[], []]);
  assert.deepEqual(returned.deleted, []);
});

test('a record outside the lookback window leaves the snapshot and is never deleted', async () => {
  const policy = new ClosedWorld();
  const window = { rereads: (record: Item) => record.value >= '2' };
  const first = await changes(
    items(policy).diff(
      [
        { id: 'settled', value: '1' },
        { id: 'restated', value: '2' },
      ],
      null,
      window,
    ),
  );

  const second = await changes(
    items(policy).diff([{ id: 'restated', value: '2' }], first.state, window),
  );

  assert.deepEqual(Object.keys(first.state.snapshot), ['["restated"]']);
  assert.deepEqual([second.inserted, second.updated], [[], []]);
  assert.deepEqual(second.deleted, []);
});

test('a part that continues a scan judges no vanished key, so a record the scan has not reached yet keeps its key', async () => {
  const policy = new ClosedWorld();
  const loaded = await changes(
    items(policy).diff(
      [
        { id: 'a', value: '1' },
        { id: 'b', value: '1' },
        { id: 'c', value: '1' },
      ],
      null,
    ),
  );

  const part = await changes(
    items(policy).diff([{ id: 'a', value: '1' }], loaded.state, {
      continues: true,
    }),
  );

  assert.deepEqual(part.deleted, []);
  assert.deepEqual(Object.keys(part.state.snapshot), [
    '["a"]',
    '["b"]',
    '["c"]',
  ]);
});

test('the part that ends a scan deletes only the keys that no part listed', async () => {
  const policy = new ClosedWorld();
  const loaded = await changes(
    items(policy).diff(
      [
        { id: 'a', value: '1' },
        { id: 'b', value: '1' },
        { id: 'c', value: '1' },
      ],
      null,
    ),
  );
  const first = await changes(
    items(policy).diff([{ id: 'a', value: '1' }], loaded.state, {
      continues: true,
    }),
  );

  const last = await changes(
    items(policy).diff([{ id: 'b', value: '1' }], first.state),
  );

  assert.deepEqual(last.deleted, ['c']);
  assert.deepEqual(last.state, {
    snapshot: {
      '["a"]': loaded.state.snapshot['["a"]'],
      '["b"]': loaded.state.snapshot['["b"]'],
    },
  });
});

test('a changed record updates in the part that lists it, before its scan ends', async () => {
  const policy = new ClosedWorld();
  const loaded = await changes(
    items(policy).diff(
      [
        { id: 'a', value: '1' },
        { id: 'b', value: '1' },
      ],
      null,
    ),
  );

  const part = await changes(
    items(policy).diff([{ id: 'a', value: '2' }], loaded.state, {
      continues: true,
    }),
  );
  const last = await changes(
    items(policy).diff([{ id: 'b', value: '1' }], part.state),
  );

  assert.deepEqual([part.inserted, part.updated], [[], ['a']]);
  assert.deepEqual([last.inserted, last.updated], [[], []]);
  assert.deepEqual(last.deleted, []);
});

test('two parts of one scan may list the same key, and one part may not list it twice', async () => {
  const policy = new ClosedWorld();
  const first = await changes(
    items(policy).diff([{ id: 'a', value: '1' }], null, { continues: true }),
  );

  const overlap = await changes(
    items(policy).diff([{ id: 'a', value: '1' }], first.state),
  );

  assert.deepEqual([overlap.inserted, overlap.updated], [[], []]);
  assert.deepEqual(Object.keys(overlap.state.snapshot), ['["a"]']);
  await assert.rejects(
    Array.fromAsync(
      items(policy).diff(
        [
          { id: 'a', value: '1' },
          { id: 'a', value: '1' },
        ],
        first.state,
        { continues: true },
      ),
    ),
    /Snapshot items returned id a twice in one scan/,
  );
});

test('a new scan judges again a key the previous scan listed', async () => {
  const policy = new ClosedWorld();
  const first = await changes(
    items(policy).diff(
      [
        { id: 'a', value: '1' },
        { id: 'b', value: '1' },
      ],
      null,
      { continues: true },
    ),
  );
  const ended = await changes(items(policy).diff([], first.state));

  const next = await changes(
    items(policy).diff([{ id: 'b', value: '1' }], ended.state, {
      continues: true,
    }),
  );
  const nextEnded = await changes(items(policy).diff([], next.state));

  assert.deepEqual(ended.deleted, []);
  assert.deepEqual(nextEnded.deleted, ['a']);
});

test('a grouped scan keeps an unchanged group unread, follows a record that moves between groups, and keeps unknown keys after their group vanishes', async () => {
  const everything = new Coverage(() => true);
  const unread: SnapshotGroup<Item> = {
    key: 'one',
    fingerprint: 'v1',
    records: () => {
      throw new Error('An unchanged group was read');
    },
  };
  const first = await changes(
    items(everything).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v1', [{ id: 'b', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );

  // two empties and three takes b over unchanged.
  const moved = await changes(
    items(everything).diffGroups(
      [
        unread,
        group('two', 'v2', []),
        group('three', 'v1', [{ id: 'b', value: '1' }]),
      ],
      first.state.snapshot,
    ),
  );
  // three vanishes, outside what the scan covers.
  const evicted = await changes(
    items(new Coverage(({ key }) => key.id !== 'b')).diffGroups(
      [unread, group('two', 'v2', [])],
      moved.state.snapshot,
    ),
  );
  const covered = await changes(
    items(everything).diffGroups(
      [unread, group('two', 'v2', [])],
      evicted.state.snapshot,
    ),
  );

  assert.deepEqual([first.inserted, first.updated], [['a', 'b'], []]);
  assert.deepEqual([moved.inserted, moved.updated], [[], []]);
  assert.deepEqual(moved.deleted, []);
  assert.deepEqual(evicted.deleted, []);
  assert.deepEqual([...evicted.state.snapshot.unknown.keys()], ['["b"]']);
  assert.deepEqual(covered.deleted, ['b']);
  assert.equal(covered.state.snapshot.unknown.size, 0);
});

test('a kept group keeps its saved fingerprint and records unread, so the scan deletes nothing and saves the same state', async () => {
  const policy = new ClosedWorld();
  const first = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v1', [{ id: 'b', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );

  const kept = await changes(
    items(policy).diffGroups(
      [{ key: 'one', kept: true }, group('two', 'v1', [])],
      first.state.snapshot,
    ),
  );

  assert.deepEqual([kept.inserted, kept.updated], [[], []]);
  assert.deepEqual(kept.deleted, []);
  assert.deepEqual(kept.state.snapshot, first.state.snapshot);
});

test('a group kept in a scan in parts is listed, so the part that ends the scan does not delete its records', async () => {
  const policy = new ClosedWorld();
  const loaded = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v1', [{ id: 'b', value: '1' }]),
        group('three', 'v1', [{ id: 'c', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );

  const first = await changes(
    items(policy).diffGroups(
      [{ key: 'one', kept: true }],
      loaded.state.snapshot,
      {
        continues: true,
      },
    ),
  );
  const last = await changes(
    items(policy).diffGroups(
      [group('two', 'v1', [{ id: 'b', value: '1' }])],
      first.state.snapshot,
    ),
  );

  assert.deepEqual(last.deleted, ['c']);
  assert.deepEqual(
    last.state.snapshot.groups.get('one'),
    loaded.state.snapshot.groups.get('one'),
  );
});

test('a grouped scan in parts keeps the groups it has not reached and, at its last part, deletes the records of the groups no part listed', async () => {
  const policy = new ClosedWorld();
  const loaded = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v1', [{ id: 'b', value: '1' }]),
        group('three', 'v1', [{ id: 'c', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );

  const first = await changes(
    items(policy).diffGroups(
      [group('one', 'v2', [{ id: 'a', value: '2' }])],
      loaded.state.snapshot,
      { continues: true },
    ),
  );
  const last = await changes(
    items(policy).diffGroups(
      [group('two', 'v1', [{ id: 'b', value: '1' }])],
      first.state.snapshot,
    ),
  );

  assert.deepEqual([first.inserted, first.updated], [[], ['a']]);
  assert.deepEqual(first.deleted, []);
  assert.deepEqual(last.deleted, ['c']);
  assert.deepEqual(
    new Set(last.state.snapshot.groups.keys()),
    new Set(['one', 'two']),
  );
});

// A source whose groups are complete partitions, such as the pages of a web
// crawl: a key that vanished from a group the scan listed again is deleted,
// and the key of a group the scan did not list expires. It keeps what each
// vanished key told it.
class ListedGroups extends DeletionPolicy {
  readonly vanishedRecords: VanishedRecord[] = [];
  override vanished(record: VanishedRecord): Verdict {
    this.vanishedRecords.push(record);
    return record.group?.listed === true ? 'deleted' : 'expired';
  }
}

test('a vanished key names the group that held it and whether the scan listed that group, also in a scan in parts, and a key of an ungrouped scan names no group', async () => {
  const loaded = await changes(
    items(new ClosedWorld()).diffGroups(
      [
        group('one', 'v1', [
          { id: 'a', value: '1' },
          { id: 'b', value: '1' },
        ]),
        group('two', 'v1', [{ id: 'c', value: '1' }]),
        group('three', 'v1', [{ id: 'd', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );
  const policy = new ListedGroups();

  const first = await changes(
    items(policy).diffGroups(
      [group('one', 'v2', [{ id: 'a', value: '1' }])],
      loaded.state.snapshot,
      { continues: true },
    ),
  );
  const last = await changes(
    items(policy).diffGroups(
      [group('two', 'v1', [{ id: 'c', value: '1' }])],
      first.state.snapshot,
    ),
  );

  assert.deepEqual(last.deleted, ['b']);
  assert.deepEqual(
    policy.vanishedRecords.toSorted((left, right) =>
      String(left.key.id).localeCompare(String(right.key.id)),
    ),
    [
      { key: { id: 'b' }, group: { key: 'one', listed: true } },
      { key: { id: 'd' }, group: { key: 'three', listed: false } },
    ],
  );
  const ungrouped = new ListedGroups();
  const scanned = await changes(
    items(ungrouped).diff([{ id: 'a', value: '1' }], null),
  );
  await changes(items(ungrouped).diff([], scanned.state));
  assert.deepEqual(ungrouped.vanishedRecords, [{ key: { id: 'a' } }]);
});

test('a group the scan failed to read keeps its saved fingerprint and records, so its keys neither vanish nor expire, and the scan that reads it again deletes only what it no longer gives', async () => {
  const policy = new ListedGroups();
  const loaded = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [
          { id: 'a', value: '1' },
          { id: 'b', value: '1' },
        ]),
        group('two', 'v1', [{ id: 'c', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );

  const failed = await changes(
    items(policy).diffGroups(
      [{ key: 'one', failed: true }, group('two', 'v1', [])],
      loaded.state.snapshot,
    ),
  );
  const read = await changes(
    items(policy).diffGroups(
      [group('one', 'v2', [{ id: 'a', value: '1' }]), group('two', 'v1', [])],
      failed.state.snapshot,
    ),
  );

  assert.deepEqual(
    [failed.inserted, failed.updated, failed.deleted],
    [[], [], []],
  );
  assert.deepEqual(failed.state.snapshot, loaded.state.snapshot);
  assert.deepEqual(read.deleted, ['b']);
});

test('a failed group that the snapshot does not have keeps nothing and is no error, so the scan that reads it inserts its records', async () => {
  const policy = new ListedGroups();
  const loaded = await changes(
    items(policy).diffGroups(
      [group('two', 'v1', [{ id: 'c', value: '1' }])],
      SnapshotDifferential.noGroups,
    ),
  );

  const failed = await changes(
    items(policy).diffGroups(
      [{ key: 'one', failed: true }, group('two', 'v1', [])],
      loaded.state.snapshot,
    ),
  );
  const read = await changes(
    items(policy).diffGroups(
      [group('one', 'v1', [{ id: 'a', value: '1' }]), group('two', 'v1', [])],
      failed.state.snapshot,
    ),
  );

  assert.deepEqual(failed.state.snapshot, loaded.state.snapshot);
  assert.deepEqual([read.inserted, read.deleted], [['a'], []]);
});

test('a group failed in a part of a scan in parts keeps its keys through the part that ends the scan', async () => {
  const policy = new ListedGroups();
  const loaded = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v1', [{ id: 'b', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );

  const first = await changes(
    items(policy).diffGroups(
      [{ key: 'one', failed: true }],
      loaded.state.snapshot,
      {
        continues: true,
      },
    ),
  );
  const last = await changes(
    items(policy).diffGroups(
      [group('two', 'v1', [{ id: 'b', value: '1' }])],
      first.state.snapshot,
    ),
  );

  assert.deepEqual(last.deleted, []);
  assert.deepEqual(last.state.snapshot, loaded.state.snapshot);
});

test('a record that a read group gives, which a failed group of the same scan held, moved: it leaves the failed group with no change, before or after that group', async () => {
  const policy = new ListedGroups();
  const loaded = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v1', [
          { id: 'b', value: '1' },
          { id: 'c', value: '1' },
        ]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );
  const shifted = group('one', 'v2', [
    { id: 'a', value: '1' },
    { id: 'b', value: '1' },
  ]);
  const scans = [];

  for (const groups of [
    [shifted, { key: 'two', failed: true } as const],
    [{ key: 'two', failed: true } as const, shifted],
  ]) {
    const scan = await changes(
      items(policy).diffGroups(groups, loaded.state.snapshot),
    );
    scans.push({
      changed: [scan.inserted, scan.updated, scan.deleted],
      groups: Object.fromEntries(
        [...scan.state.snapshot.groups].map(([key, saved]) => [
          key,
          Object.keys(saved.snapshot),
        ]),
      ),
    });
  }

  const moved = {
    changed: [[], [], []],
    groups: { one: ['["a"]', '["b"]'], two: ['["c"]'] },
  };
  assert.deepEqual(scans, [moved, moved]);
});

test('a record that vanishes from a group a continuing part reads again is deleted when the scan ends', async () => {
  const policy = new ClosedWorld();
  const loaded = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [
          { id: 'a', value: '1' },
          { id: 'b', value: '1' },
        ]),
        group('two', 'v1', [{ id: 'c', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );

  const first = await changes(
    items(policy).diffGroups(
      [group('one', 'v2', [{ id: 'a', value: '1' }])],
      loaded.state.snapshot,
      { continues: true },
    ),
  );
  const last = await changes(
    items(policy).diffGroups([group('two', 'v1', [])], first.state.snapshot),
  );

  assert.deepEqual(first.deleted, []);
  assert.deepEqual(last.deleted, ['b']);
});

test('a key judged unknown stays through a continuing part, and the part that ends the scan judges it again', async () => {
  const loaded = await changes(
    items(new Coverage(() => false)).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v1', [{ id: 'b', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );
  // b vanishes where the scan cannot tell: unknown.
  const uncovered = await changes(
    items(new Coverage(() => false)).diffGroups(
      [group('one', 'v1', [])],
      loaded.state.snapshot,
    ),
  );

  const part = await changes(
    items(new Coverage(() => true)).diffGroups(
      [group('one', 'v1', [])],
      uncovered.state.snapshot,
      { continues: true },
    ),
  );
  const last = await changes(
    items(new Coverage(() => true)).diffGroups(
      [group('one', 'v1', [])],
      part.state.snapshot,
    ),
  );

  assert.deepEqual([...uncovered.state.snapshot.unknown.keys()], ['["b"]']);
  assert.deepEqual(part.deleted, []);
  assert.deepEqual(last.deleted, ['b']);
});

test('a record that moves into a group a later part lists is judged with that group, not with the group an earlier part listed', async () => {
  const policy = new ClosedWorld();
  const loaded = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v1', [{ id: 'b', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );
  const first = await changes(
    items(policy).diffGroups([group('two', 'v1', [])], loaded.state.snapshot, {
      continues: true,
    }),
  );
  // b moved from two into one.
  const moved = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v2', [
          { id: 'a', value: '1' },
          { id: 'b', value: '1' },
        ]),
      ],
      first.state.snapshot,
    ),
  );

  // b leaves one; two, unchanged and unread, must not still vouch for it.
  const removed = await changes(
    items(policy).diffGroups(
      [group('one', 'v3', [{ id: 'a', value: '1' }]), group('two', 'v1', [])],
      moved.state.snapshot,
    ),
  );

  assert.deepEqual([moved.inserted, moved.updated], [[], []]);
  assert.deepEqual(moved.deleted, []);
  assert.deepEqual(removed.deleted, ['b']);
});

test('a grouped scan inserts a record whose key no group had and updates a changed record, also when it moves to another group', async () => {
  const policy = new ClosedWorld();
  const first = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [
          { id: 'a', value: '1' },
          { id: 'b', value: '1' },
        ]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );

  const second = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v2', [{ id: 'a', value: '2' }]),
        group('two', 'v1', [
          { id: 'b', value: '2' },
          { id: 'c', value: '1' },
        ]),
      ],
      first.state.snapshot,
    ),
  );

  assert.deepEqual([first.inserted, first.updated], [['a', 'b'], []]);
  assert.deepEqual([second.inserted, second.updated], [['c'], ['a', 'b']]);
});

test('a key judged unknown that a later scan lists changed is an update, since the snapshot still has it', async () => {
  const outside = new Coverage(({ key }) => key.id !== 'b');
  const everything = new Coverage(() => true);
  const loaded = await changes(
    items(everything).diff(
      [
        { id: 'a', value: '1' },
        { id: 'b', value: '1' },
      ],
      null,
    ),
  );
  const groupsLoaded = await changes(
    items(everything).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v1', [{ id: 'b', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );
  const evicted = await changes(
    items(outside).diff([{ id: 'a', value: '1' }], loaded.state),
  );
  const groupsEvicted = await changes(
    items(outside).diffGroups(
      [group('one', 'v1', [{ id: 'a', value: '1' }])],
      groupsLoaded.state.snapshot,
    ),
  );

  const returned = await changes(
    items(everything).diff(
      [
        { id: 'a', value: '1' },
        { id: 'b', value: '2' },
      ],
      evicted.state,
    ),
  );
  const groupsReturned = await changes(
    items(everything).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v2', [{ id: 'b', value: '2' }]),
      ],
      groupsEvicted.state.snapshot,
    ),
  );

  assert.deepEqual([...groupsEvicted.state.snapshot.unknown.keys()], ['["b"]']);
  assert.deepEqual([returned.inserted, returned.updated], [[], ['b']]);
  assert.deepEqual(
    [groupsReturned.inserted, groupsReturned.updated],
    [[], ['b']],
  );
});

// The keys that one grouped diff put and removed in each collection.
function keysOf(changes: GroupedSnapshotChanges) {
  return Object.fromEntries(
    Object.entries(changes).map(([collection, { put, remove }]) => [
      collection,
      { put: [...put.keys()].sort(), remove: [...remove].sort() },
    ]),
  );
}

test('a part of a scan in parts puts only the group it read and lists only that group', async () => {
  const policy = new ClosedWorld();
  const loaded = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v1', [{ id: 'b', value: '1' }]),
        group('three', 'v1', [{ id: 'c', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );

  const first = await changes(
    items(policy).diffGroups(
      [group('one', 'v2', [{ id: 'a', value: '2' }])],
      loaded.state.snapshot,
      { continues: true },
    ),
  );
  const second = await changes(
    items(policy).diffGroups(
      [group('two', 'v2', [{ id: 'b', value: '2' }])],
      first.state.snapshot,
      { continues: true },
    ),
  );

  const nothing = { put: [], remove: [] };
  assert.deepEqual(keysOf(first.state.changes), {
    groups: { put: ['one'], remove: [] },
    unknown: nothing,
    listed: { put: ['one'], remove: [] },
  });
  assert.deepEqual(keysOf(second.state.changes), {
    groups: { put: ['two'], remove: [] },
    unknown: nothing,
    listed: { put: ['two'], remove: [] },
  });
  assert.deepEqual(first.state.changes.groups.put.get('one'), {
    fingerprint: 'v2',
    snapshot: { '["a"]': 'nIxjaJfvAEBXK8JbMcgyI6oYcBNEUxrSekNyb60wviI' },
  });
  assert.deepEqual([...second.state.snapshot.listed].sort(), ['one', 'two']);
});

test('a group whose fingerprint did not change and a kept group put no group, and a rescan that changed nothing puts and removes nothing', async () => {
  const policy = new ClosedWorld();
  const loaded = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v1', [{ id: 'b', value: '1' }]),
        group('three', 'v1', [{ id: 'c', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );

  const scan = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        { key: 'two', kept: true },
        group('three', 'v2', [{ id: 'c', value: '2' }]),
      ],
      loaded.state.snapshot,
    ),
  );
  const again = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        { key: 'two', kept: true },
        group('three', 'v2', [{ id: 'c', value: '2' }]),
      ],
      scan.state.snapshot,
    ),
  );

  const nothing = { put: [], remove: [] };
  assert.deepEqual(keysOf(loaded.state.changes), {
    groups: { put: ['one', 'three', 'two'], remove: [] },
    unknown: nothing,
    listed: nothing,
  });
  assert.deepEqual(keysOf(scan.state.changes), {
    groups: { put: ['three'], remove: [] },
    unknown: nothing,
    listed: nothing,
  });
  assert.deepEqual(keysOf(again.state.changes), {
    groups: nothing,
    unknown: nothing,
    listed: nothing,
  });
});

test('a record that moves out of a group the diff did not read puts that group without the record, for a failed group and for a group a part has not reached', async () => {
  const policy = new ClosedWorld();
  const loaded = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v1', [
          { id: 'b', value: '1' },
          { id: 'c', value: '1' },
        ]),
        group('three', 'v1', [{ id: 'd', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );
  const shifted = group('one', 'v2', [
    { id: 'a', value: '1' },
    { id: 'b', value: '1' },
  ]);

  const failed = await changes(
    items(policy).diffGroups(
      [shifted, { key: 'two', failed: true }, { key: 'three', kept: true }],
      loaded.state.snapshot,
    ),
  );
  const part = await changes(
    items(policy).diffGroups([shifted], loaded.state.snapshot, {
      continues: true,
    }),
  );

  for (const { state } of [failed, part]) {
    assert.deepEqual([...state.changes.groups.put.keys()].sort(), [
      'one',
      'two',
    ]);
    assert.deepEqual(
      Object.keys(state.changes.groups.put.get('two')?.snapshot ?? {}),
      ['["c"]'],
    );
    assert.deepEqual(state.changes.groups.put.get('two')?.fingerprint, 'v1');
  }
});

test('a key that vanishes in a part waits in unknown with the group that held it, a later part does not put it again, and the last part deletes it and removes it from unknown', async () => {
  const loaded = await changes(
    items(new ClosedWorld()).diffGroups(
      [
        group('one', 'v1', [
          { id: 'a', value: '1' },
          { id: 'b', value: '1' },
        ]),
        group('two', 'v1', [{ id: 'c', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );
  const policy = new ListedGroups();

  const part = await changes(
    items(policy).diffGroups(
      [group('one', 'v2', [{ id: 'a', value: '1' }])],
      loaded.state.snapshot,
      { continues: true },
    ),
  );
  // b still waits, unchanged.
  const next = await changes(
    items(policy).diffGroups([], part.state.snapshot, { continues: true }),
  );
  const last = await changes(
    items(policy).diffGroups(
      [group('two', 'v1', [{ id: 'c', value: '1' }])],
      next.state.snapshot,
    ),
  );

  const waiting = {
    saved: loaded.state.snapshot.groups.get('one')?.snapshot['["b"]'],
    holder: 'one',
  };
  assert.deepEqual([...part.state.changes.unknown.put], [['["b"]', waiting]]);
  assert.deepEqual(part.state.snapshot.unknown.get('["b"]'), waiting);
  assert.deepEqual(keysOf(next.state.changes).unknown, {
    put: [],
    remove: [],
  });
  assert.deepEqual(last.deleted, ['b']);
  assert.deepEqual(policy.vanishedRecords, [
    { key: { id: 'b' }, group: { key: 'one', listed: true } },
  ]);
  assert.deepEqual([...last.state.changes.unknown.remove], ['["b"]']);
  assert.equal(last.state.snapshot.unknown.size, 0);
});

test('the last part removes every listed group and every group that the scan neither listed nor failed to read', async () => {
  const policy = new ClosedWorld();
  const loaded = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v1', [{ id: 'b', value: '1' }]),
        group('three', 'v1', [{ id: 'c', value: '1' }]),
        group('four', 'v1', [{ id: 'd', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );
  const first = await changes(
    items(policy).diffGroups(
      [group('one', 'v1', [{ id: 'a', value: '1' }])],
      loaded.state.snapshot,
      { continues: true },
    ),
  );

  const last = await changes(
    items(policy).diffGroups(
      [
        { key: 'two', failed: true },
        { key: 'three', kept: true },
      ],
      first.state.snapshot,
    ),
  );

  assert.deepEqual(last.deleted, ['d']);
  assert.deepEqual(keysOf(last.state.changes), {
    groups: { put: [], remove: ['four'] },
    unknown: { put: [], remove: [] },
    listed: { put: [], remove: ['one'] },
  });
  assert.deepEqual([...last.state.snapshot.groups.keys()].sort(), [
    'one',
    'three',
    'two',
  ]);
  assert.equal(last.state.snapshot.listed.size, 0);
});

test('a failed group that no record moved out of puts no group and is listed, also one that the snapshot does not have', async () => {
  const policy = new ClosedWorld();
  const loaded = await changes(
    items(policy).diffGroups(
      [group('one', 'v1', [{ id: 'a', value: '1' }])],
      SnapshotDifferential.noGroups,
    ),
  );

  const part = await changes(
    items(policy).diffGroups(
      [
        { key: 'one', failed: true },
        { key: 'new', failed: true },
      ],
      loaded.state.snapshot,
      { continues: true },
    ),
  );
  const last = await changes(items(policy).diffGroups([], part.state.snapshot));

  assert.deepEqual(keysOf(part.state.changes), {
    groups: { put: [], remove: [] },
    unknown: { put: [], remove: [] },
    listed: { put: ['new', 'one'], remove: [] },
  });
  assert.deepEqual(last.deleted, []);
  assert.deepEqual(keysOf(last.state.changes), {
    groups: { put: [], remove: [] },
    unknown: { put: [], remove: [] },
    listed: { put: [], remove: ['new', 'one'] },
  });
});

test('a store that folds the changes of each diff into its saved entries and reads them back with savedGroups gets the same next diff as a caller that passes the snapshot along', async () => {
  // u leaves the scan where the scan cannot tell, so it stays unknown. Every
  // other key is judged by its group, which a store must keep for it.
  const policy = new (class extends ListedGroups {
    override vanished(record: VanishedRecord): Verdict {
      return record.key.id === 'u' ? 'unknown' : super.vanished(record);
    }
  })();
  const scans: {
    groups: Parameters<SnapshotDifferential<Item>['diffGroups']>[0];
    continues?: boolean;
  }[] = [
    {
      groups: [
        group('one', 'v1', [
          { id: 'a', value: '1' },
          { id: 'b', value: '1' },
        ]),
        group('two', 'v1', [
          { id: 'c', value: '1' },
          { id: 'u', value: '1' },
        ]),
        group('three', 'v1', [{ id: 'd', value: '1' }]),
      ],
    },
    // b vanishes from one and waits with its holder; u vanishes too.
    {
      groups: [group('one', 'v2', [{ id: 'a', value: '2' }])],
      continues: true,
    },
    // c moves into four; two failed.
    {
      groups: [
        { key: 'two', failed: true },
        group('four', 'v1', [{ id: 'c', value: '1' }]),
      ],
      continues: true,
    },
    // The last part: b vanished from one, which a part listed, so it is
    // deleted; three is not listed, so d expires.
    { groups: [{ key: 'four', kept: true }] },
    // A scan that reads two again and lists u changed.
    {
      groups: [
        group('one', 'v2', [{ id: 'a', value: '2' }]),
        group('two', 'v2', [{ id: 'u', value: '2' }]),
        { key: 'four', kept: true },
      ],
    },
  ];
  // A store saves each entry under its key, as JSON.
  const store = {
    groups: new Map<string, unknown>(),
    unknown: new Map<string, unknown>(),
    listed: new Map<string, unknown>(),
  };
  const fold = (
    saved: Map<string, unknown>,
    { put, remove }: KeyedChanges<unknown>,
  ) => {
    for (const key of remove) saved.delete(key);
    for (const [key, value] of put)
      saved.set(key, JSON.parse(JSON.stringify(value)));
  };
  const differential = items(policy);
  let passed = SnapshotDifferential.noGroups;
  let read = SnapshotDifferential.noGroups;
  const results = [];

  for (const { groups, continues = false } of scans) {
    const along = await changes(
      differential.diffGroups(groups, passed, { continues }),
    );
    const folded = await changes(
      differential.diffGroups(groups, read, { continues }),
    );
    fold(store.groups, folded.state.changes.groups);
    fold(store.unknown, folded.state.changes.unknown);
    fold(store.listed, folded.state.changes.listed);
    passed = along.state.snapshot;
    read = differential.savedGroups(store);
    results.push({ along, folded, read, passed });
  }

  for (const { along, folded, read, passed } of results) {
    assert.deepEqual(
      [folded.inserted, folded.updated, folded.deleted],
      [along.inserted, along.updated, along.deleted],
    );
    assert.deepEqual(read, passed);
  }
  assert.deepEqual(
    results.map(({ along }) => [along.inserted, along.updated, along.deleted]),
    [
      [['a', 'b', 'c', 'u', 'd'], [], []],
      [[], ['a'], []],
      [[], [], []],
      [[], [], ['b']],
      [[], ['u'], []],
    ],
  );
});

// A saved entry that diffGroups writes: one group, a key that waits for it,
// and the group listed as failed.
function savedEntry() {
  const group = { fingerprint: 'v1', snapshot: { '["a"]': 'f' } };
  const valid = {
    groups: new Map([['one', group]]),
    unknown: new Map([['["b"]', { saved: 'f', holder: 'one' }]]),
    listed: new Map([['one', true]]),
  };
  return { group, valid };
}

test('savedGroups reads a saved entry that diffGroups wrote, and lists a failed group that the snapshot does not have', () => {
  const differential = items(new ClosedWorld());
  const { group, valid } = savedEntry();

  const read = differential.savedGroups(valid);

  assert.deepEqual(read, {
    groups: new Map([['one', group]]),
    unknown: new Map([['["b"]', { saved: 'f', holder: 'one' }]]),
    listed: new Set(['one']),
  });
  assert.equal(read.groups.get('one')?.snapshot, group.snapshot);
  // A failed group that the snapshot does not have is listed with no group.
  assert.deepEqual(
    differential.savedGroups({ ...valid, listed: new Map([['new', true]]) })
      .listed,
    new Set(['new']),
  );
});

void test.each(
  [
    {
      name: 'a group that is not an object',
      saved: ({ valid }: ReturnType<typeof savedEntry>) => ({
        ...valid,
        groups: new Map([['one', 'v1']]),
      }),
    },
    {
      name: 'a fingerprint that is a number',
      saved: ({ valid, group }: ReturnType<typeof savedEntry>) => ({
        ...valid,
        groups: new Map([['one', { ...group, fingerprint: 1 }]]),
      }),
    },
    {
      name: 'a snapshot entry that is a number',
      saved: ({ valid, group }: ReturnType<typeof savedEntry>) => ({
        ...valid,
        groups: new Map([['one', { ...group, snapshot: { a: 1 } }]]),
      }),
    },
    {
      name: 'a waiting key that is not an object',
      saved: ({ valid }: ReturnType<typeof savedEntry>) => ({
        ...valid,
        unknown: new Map([['["b"]', 'f']]),
      }),
    },
    {
      name: 'a waiting key whose saved fingerprint is a list',
      saved: ({ valid }: ReturnType<typeof savedEntry>) => ({
        ...valid,
        unknown: new Map([['["b"]', { saved: ['f'] }]]),
      }),
    },
    {
      name: 'a waiting key whose holder is a number',
      saved: ({ valid }: ReturnType<typeof savedEntry>) => ({
        ...valid,
        unknown: new Map([['["b"]', { saved: 'f', holder: 1 }]]),
      }),
    },
    {
      name: 'a listed group whose value is text',
      saved: ({ valid }: ReturnType<typeof savedEntry>) => ({
        ...valid,
        listed: new Map([['one', 'yes']]),
      }),
    },
    {
      // A waiting key's holder is a group of the snapshot.
      name: 'a waiting key whose holder is not a group of the snapshot',
      saved: ({ valid }: ReturnType<typeof savedEntry>) => ({
        ...valid,
        unknown: new Map([['["b"]', { saved: 'f', holder: 'two' }]]),
      }),
    },
    {
      name: 'a listed group whose value is false',
      saved: () => {
        const none = new Map<string, unknown>();
        return {
          groups: none,
          unknown: none,
          listed: new Map([['one', false]]),
        };
      },
    },
  ],
  (row) =>
    test(`savedGroups rejects a saved entry that diffGroups did not write, and names the snapshot: ${row.name}`, () => {
      const differential = items(new ClosedWorld());
      const saved = row.saved(savedEntry());

      assert.throws(
        () => differential.savedGroups(saved),
        (error) =>
          error instanceof TypeError &&
          error.message === 'Snapshot items state is not a saved snapshot',
      );
    }),
);

// The entries of a grouped snapshot, as text to compare before and after.
function serialized(snapshot: GroupedSnapshot): string {
  return JSON.stringify([
    [...snapshot.groups],
    [...snapshot.unknown],
    [...snapshot.listed],
  ]);
}

test('the first scan from noGroups puts every group it reads with its records sorted by key, yields an insert for each record, and lists nothing', async () => {
  const policy = new ClosedWorld();

  const first = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [
          { id: 'b', value: '1' },
          { id: 'a', value: '1' },
        ]),
        group('two', null, [{ id: 'c', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );

  assert.deepEqual(first.inserted, ['b', 'a', 'c']);
  assert.deepEqual(keysOf(first.state.changes), {
    groups: { put: ['one', 'two'], remove: [] },
    unknown: { put: [], remove: [] },
    listed: { put: [], remove: [] },
  });
  assert.deepEqual(
    Object.keys(first.state.changes.groups.put.get('one')?.snapshot ?? {}),
    ['["a"]', '["b"]'],
  );
  assert.equal(first.state.snapshot.listed.size, 0);
});

test('a record that moves out of an unread group leaves the rest of its records sorted by key', async () => {
  const policy = new ClosedWorld();
  const loaded = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [
          { id: 'c', value: '1' },
          { id: 'b', value: '1' },
          { id: 'a', value: '1' },
        ]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );

  const moved = await changes(
    items(policy).diffGroups(
      [
        { key: 'one', failed: true },
        group('two', 'v1', [{ id: 'b', value: '1' }]),
      ],
      loaded.state.snapshot,
    ),
  );

  assert.deepEqual(
    Object.keys(moved.state.snapshot.groups.get('one')?.snapshot ?? {}),
    ['["a"]', '["c"]'],
  );
});

test('noGroups is a new snapshot at each read, so a caller that changes one does not change the first scan of another', async () => {
  const policy = new ClosedWorld();
  const changed = SnapshotDifferential.noGroups;
  Reflect.apply(Map.prototype.set, changed.groups, [
    'one',
    { fingerprint: 'v1', snapshot: { '["a"]': 'f' } },
  ]);

  const other = await changes(
    items(policy).diffGroups(
      [group('one', 'v1', [{ id: 'a', value: '1' }])],
      SnapshotDifferential.noGroups,
    ),
  );

  assert.deepEqual(other.inserted, ['a']);
  assert.equal(SnapshotDifferential.noGroups.groups.size, 0);
});

test('diffGroups does not change the snapshot it gets, through a scan in parts that moves, fails, keeps and judges, from noGroups on', async () => {
  const policy = new Coverage(({ key }) => key.id !== 'u');
  const scans: {
    groups: Parameters<SnapshotDifferential<Item>['diffGroups']>[0];
    continues?: boolean;
  }[] = [
    {
      groups: [
        group('one', 'v1', [
          { id: 'a', value: '1' },
          { id: 'b', value: '1' },
        ]),
        group('two', 'v1', [
          { id: 'c', value: '1' },
          { id: 'u', value: '1' },
        ]),
      ],
    },
    {
      groups: [group('one', 'v2', [{ id: 'a', value: '1' }])],
      continues: true,
    },
    {
      groups: [
        { key: 'two', failed: true },
        group('three', 'v1', [{ id: 'c', value: '1' }]),
      ],
      continues: true,
    },
    { groups: [{ key: 'three', kept: true }] },
    // two leaves the scan, so u is judged unknown, and stays.
    {
      groups: [
        group('one', 'v2', [{ id: 'a', value: '1' }]),
        { key: 'three', kept: true },
      ],
    },
    {
      groups: [
        group('one', 'v2', [{ id: 'a', value: '1' }]),
        { key: 'three', kept: true },
      ],
    },
  ];
  const differential = items(policy);
  let snapshot = SnapshotDifferential.noGroups;
  const unchanged = [];

  for (const { groups, continues = false } of scans) {
    const before = serialized(snapshot);
    const scan = await changes(
      differential.diffGroups(groups, snapshot, { continues }),
    );
    unchanged.push(serialized(snapshot) === before);
    snapshot = scan.state.snapshot;
  }

  assert.deepEqual(unchanged, [true, true, true, true, true, true]);
  assert.equal(snapshot.unknown.size, 1);
});

test('a group that a later part of the open scan lists again with the same fingerprint puts nothing', async () => {
  const policy = new ClosedWorld();
  const loaded = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v1', [{ id: 'b', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );
  const first = await changes(
    items(policy).diffGroups(
      [group('one', 'v2', [{ id: 'a', value: '2' }])],
      loaded.state.snapshot,
      { continues: true },
    ),
  );

  const again = await changes(
    items(policy).diffGroups(
      [group('one', 'v2', [{ id: 'a', value: '2' }])],
      first.state.snapshot,
      { continues: true },
    ),
  );

  const nothing = { put: [], remove: [] };
  assert.deepEqual(keysOf(again.state.changes), {
    groups: nothing,
    unknown: nothing,
    listed: nothing,
  });
});

test('a waiting key that a later part lists again leaves unknown with its holder, and the last part does not judge it', async () => {
  const loaded = await changes(
    items(new ClosedWorld()).diffGroups(
      [
        group('one', 'v1', [
          { id: 'a', value: '1' },
          { id: 'b', value: '1' },
        ]),
        group('two', 'v1', [{ id: 'c', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );
  const policy = new ListedGroups();
  const first = await changes(
    items(policy).diffGroups(
      [group('one', 'v2', [{ id: 'a', value: '1' }])],
      loaded.state.snapshot,
      { continues: true },
    ),
  );

  // b comes back in two, unchanged.
  const back = await changes(
    items(policy).diffGroups(
      [
        group('two', 'v2', [
          { id: 'b', value: '1' },
          { id: 'c', value: '1' },
        ]),
      ],
      first.state.snapshot,
      { continues: true },
    ),
  );
  const last = await changes(items(policy).diffGroups([], back.state.snapshot));

  assert.deepEqual([back.inserted, back.updated], [[], []]);
  assert.deepEqual([...back.state.changes.unknown.remove], ['["b"]']);
  assert.equal(back.state.snapshot.unknown.size, 0);
  assert.deepEqual(last.deleted, []);
  assert.deepEqual(policy.vanishedRecords, []);
});

test('a key judged unknown stays in unknown with no holder and no put or remove, through a scan in parts and through a rescan', async () => {
  const loaded = await changes(
    items(new ClosedWorld()).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v1', [{ id: 'b', value: '1' }]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );
  const policy = new Coverage(() => false);
  // b vanishes with two, where the scan cannot tell.
  const judged = await changes(
    items(policy).diffGroups(
      [group('one', 'v1', [{ id: 'a', value: '1' }])],
      loaded.state.snapshot,
    ),
  );

  const part = await changes(
    items(policy).diffGroups(
      [{ key: 'one', kept: true }],
      judged.state.snapshot,
      {
        continues: true,
      },
    ),
  );
  const last = await changes(items(policy).diffGroups([], part.state.snapshot));
  const rescan = await changes(
    items(policy).diffGroups(
      [{ key: 'one', kept: true }],
      judged.state.snapshot,
    ),
  );

  const nothing = { put: [], remove: [] };
  assert.deepEqual(judged.state.snapshot.unknown.get('["b"]'), {
    saved: loaded.state.snapshot.groups.get('two')?.snapshot['["b"]'],
  });
  for (const { state } of [part, last, rescan]) {
    assert.deepEqual(keysOf(state.changes).unknown, nothing);
    assert.deepEqual(state.snapshot.unknown, judged.state.snapshot.unknown);
  }
});

test('a waiting key that the last part judges unknown stays in unknown without its holder', async () => {
  const loaded = await changes(
    items(new ClosedWorld()).diffGroups(
      [
        group('one', 'v1', [
          { id: 'a', value: '1' },
          { id: 'b', value: '1' },
        ]),
      ],
      SnapshotDifferential.noGroups,
    ),
  );
  const policy = new Coverage(() => false);
  const part = await changes(
    items(policy).diffGroups(
      [group('one', 'v2', [{ id: 'a', value: '1' }])],
      loaded.state.snapshot,
      { continues: true },
    ),
  );

  const last = await changes(items(policy).diffGroups([], part.state.snapshot));

  const saved = loaded.state.snapshot.groups.get('one')?.snapshot['["b"]'];
  assert.deepEqual(part.state.snapshot.unknown.get('["b"]'), {
    saved,
    holder: 'one',
  });
  assert.deepEqual([...last.state.changes.unknown.put], [['["b"]', { saved }]]);
  assert.deepEqual(last.deleted, []);
});

test('a group with no fingerprint survives savedGroups and is read again at the next scan', async () => {
  const differential = items(new ClosedWorld());
  const first = await changes(
    differential.diffGroups(
      [group('one', null, [{ id: 'a', value: '1' }])],
      SnapshotDifferential.noGroups,
    ),
  );
  const read = differential.savedGroups({
    groups: new Map(
      [...first.state.changes.groups.put].map(([key, value]) => [
        key,
        JSON.parse(JSON.stringify(value)),
      ]),
    ),
    unknown: new Map(),
    listed: new Map(),
  });
  let reads = 0;

  const next = await changes(
    differential.diffGroups(
      [
        {
          key: 'one',
          fingerprint: null,
          records: () => {
            reads++;
            return [{ id: 'a', value: '2' }];
          },
        },
      ],
      read,
    ),
  );

  assert.deepEqual(read.groups.get('one')?.fingerprint, null);
  assert.equal(reads, 1);
  assert.deepEqual(next.updated, ['a']);
  assert.deepEqual([...next.state.changes.groups.put.keys()], ['one']);
});

test('a record that holds bytes diffs by its bytes: equal bytes in a Buffer or a view change nothing, and other bytes or a string or numbers in their place update', async () => {
  type Attachment = { readonly id: string; readonly body: unknown };
  const attachments = new SnapshotDifferential<Attachment>({
    name: 'attachments',
    primaryKey: ['id'],
    key: (record) => [record.id],
    policy: new ClosedWorld(),
  });
  const kinds = async (
    diff: AsyncIterable<SnapshotChange<Attachment, unknown>>,
  ) => {
    const yielded: string[] = [];
    let saved: unknown = null;
    for await (const change of diff)
      if (change.type === 'state') saved = change.state;
      else if (change.type === 'delete')
        yielded.push(`delete ${String(change.key.id)}`);
      else yielded.push(`${change.type} ${change.record.id}`);
    return { yielded, saved };
  };
  const first = await kinds(
    attachments.diff(
      [
        { id: 'same', body: new Uint8Array([1, 2, 3]) },
        { id: 'bytes', body: { nested: [new Uint8Array([1, 2, 3])] } },
        { id: 'string', body: new Uint8Array([1, 2, 3]) },
        { id: 'numbers', body: new Uint8Array([1, 2, 3]) },
      ],
      null,
    ),
  );

  const second = await kinds(
    attachments.diff(
      [
        { id: 'same', body: Buffer.from([0, 1, 2, 3]).subarray(1) },
        { id: 'bytes', body: { nested: [new Uint8Array([1, 2, 4])] } },
        { id: 'string', body: 'AQID' },
        { id: 'numbers', body: [1, 2, 3] },
      ],
      JSON.parse(JSON.stringify(first.saved)),
    ),
  );

  assert.deepEqual(second.yielded, [
    'update bytes',
    'update string',
    'update numbers',
  ]);
});

void test.each(
  [
    { name: 'a Uint16Array', value: new Uint16Array([1]) },
    { name: 'a Uint8ClampedArray', value: new Uint8ClampedArray([1]) },
    { name: 'a Date', value: new Date(0) },
    { name: 'a Map', value: new Map([['inner', 1]]) },
    {
      name: 'an instance of a class',
      value: new (class Inner {
        inner = 1;
      })(),
    },
    { name: '-0', value: -0 },
    { name: 'NaN', value: Number.NaN },
    { name: 'an undefined property', value: { inner: undefined } },
  ],
  (row) =>
    test(`a record that holds a value JSON cannot hold with no change, other than bytes, fails: ${row.name}`, async () => {
      const loose = new SnapshotDifferential<Record<string, unknown>>({
        name: 'loose',
        primaryKey: ['id'],
        key: () => ['a'],
        policy: new ClosedWorld(),
      });

      await assert.rejects(
        Array.fromAsync(loose.diff([{ id: 'a', value: row.value }], null)),
        /Snapshot loose records must be losslessly JSON serializable, or bytes/,
      );
    }),
);

test('rows that node:sqlite reads, whose prototype is null, diff as the same rows in plain objects do', async () => {
  const rows = new SnapshotDifferential<Record<string, SQLOutputValue>>({
    name: 'rows',
    primaryKey: ['id'],
    key: (record) => [record.id ?? ''],
    policy: new ClosedWorld(),
  });
  const scan = async (
    records: Iterable<Record<string, SQLOutputValue>>,
    state: unknown,
  ) => {
    const yielded: string[] = [];
    let saved: unknown = null;
    for await (const change of rows.diff(records, state))
      if (change.type === 'state') saved = change.state;
      else if (change.type === 'delete')
        yielded.push(`delete ${String(change.key.id)}`);
      else yielded.push(`${change.type} ${String(change.record.id)}`);
    return { yielded, saved };
  };
  using database = open(':memory:');
  database.exec(
    "CREATE TABLE rows (id TEXT, value TEXT); INSERT INTO rows VALUES ('a', 'Ada'), ('b', 'Grace')",
  );
  const read = () =>
    database.prepare('SELECT id, value FROM rows ORDER BY id').iterate();

  const first = await scan(read(), null);
  const plain = await scan(
    [
      { id: 'a', value: 'Ada' },
      { id: 'b', value: 'Grace' },
    ],
    first.saved,
  );
  database.exec("UPDATE rows SET value = 'Grace Hopper' WHERE id = 'b'");
  const changed = await scan(read(), plain.saved);

  assert.deepEqual(
    [first.yielded, plain.yielded, changed.yielded],
    [['insert a', 'insert b'], [], ['update b']],
  );
});

test('a key of bytes survives the saved state: the next scan finds it, and a delete gives it back as bytes', async () => {
  type Row = { readonly id: Uint8Array | string; readonly value: string };
  const rows = new SnapshotDifferential<Row>({
    name: 'rows',
    primaryKey: ['id'],
    key: (record) => [record.id],
    policy: new ClosedWorld(),
  });
  const run = async (records: Row[], state: unknown) => {
    const yielded: unknown[] = [];
    let saved: unknown = null;
    for await (const change of rows.diff(records, state))
      if (change.type === 'state')
        saved = JSON.parse(JSON.stringify(change.state));
      else if (change.type === 'delete') yielded.push(change.key.id);
      else yielded.push(`${change.type} ${String(change.record.id)}`);
    return { yielded, saved };
  };
  const first = await run(
    [
      { id: new Uint8Array([1, 2]), value: '1' },
      { id: '{"bytes":"AQI"}', value: '1' },
      { id: 'AQI', value: '1' },
    ],
    null,
  );

  const unchanged = await run(
    [
      { id: Buffer.from([1, 2]), value: '1' },
      { id: '{"bytes":"AQI"}', value: '1' },
      { id: 'AQI', value: '1' },
    ],
    first.saved,
  );
  const vanished = await run([], unchanged.saved);

  assert.equal(first.yielded.length, 3);
  assert.deepEqual(unchanged.yielded, []);
  assert.deepEqual(vanished.yielded, [
    'AQI',
    '{"bytes":"AQI"}',
    new Uint8Array([1, 2]),
  ]);
});

test('a record that holds a bigint diffs by its exact value: the same bigint changes nothing, and the next integer or the number of the same value updates', async () => {
  type Visit = { readonly id: string; readonly task: unknown };
  const visits = new SnapshotDifferential<Visit>({
    name: 'visits',
    primaryKey: ['id'],
    key: (record) => [record.id],
    policy: new ClosedWorld(),
  });
  const run = async (records: Visit[], state: unknown) => {
    const yielded: string[] = [];
    let saved: unknown = null;
    for await (const change of visits.diff(records, state))
      if (change.type === 'state')
        saved = JSON.parse(JSON.stringify(change.state));
      else if (change.type !== 'delete')
        yielded.push(`${change.type} ${change.record.id}`);
    return { yielded, saved };
  };
  const first = await run(
    [
      { id: 'same', task: 13399287446400972n },
      { id: 'next', task: 13399287446400972n },
      { id: 'number', task: 5n },
    ],
    null,
  );

  const second = await run(
    [
      { id: 'same', task: 13399287446400972n },
      { id: 'next', task: 13399287446400973n },
      { id: 'number', task: 5 },
    ],
    first.saved,
  );

  assert.deepEqual(second.yielded, ['update next', 'update number']);
});

test('a key of bigints survives the saved state: the next scan finds it, and a delete gives it back as the same bigint, apart from the number and the string of its digits', async () => {
  type Row = { readonly id: bigint | number | string };
  const rows = new SnapshotDifferential<Row>({
    name: 'rows',
    primaryKey: ['id'],
    key: (record) => [record.id],
    policy: new ClosedWorld(),
  });
  const run = async (records: Row[], state: unknown) => {
    const yielded: unknown[] = [];
    let saved: unknown = null;
    for await (const change of rows.diff(records, state))
      if (change.type === 'state')
        saved = JSON.parse(JSON.stringify(change.state));
      else if (change.type === 'delete') yielded.push(change.key.id);
      else yielded.push(`${change.type} ${String(change.record.id)}`);
    return { yielded, saved };
  };
  const first = await run(
    [{ id: 9223372036854775807n }, { id: 5n }, { id: 5 }, { id: '5' }],
    null,
  );

  const unchanged = await run(
    [{ id: 9223372036854775807n }, { id: 5n }, { id: 5 }, { id: '5' }],
    first.saved,
  );
  const vanished = await run([], unchanged.saved);

  assert.equal(first.yielded.length, 4);
  assert.deepEqual(unchanged.yielded, []);
  assert.deepEqual(
    new Set(vanished.yielded),
    new Set([9223372036854775807n, 5n, 5, '5']),
  );
});

test('a scan that lists a key or a group twice, holds a record JSON cannot hold, or reads foreign state fails', async () => {
  const policy = new ClosedWorld();
  const loose = new SnapshotDifferential<Record<string, unknown>>({
    name: 'loose',
    primaryKey: ['id'],
    key: () => ['a'],
    policy,
  });

  const failures: [AsyncIterable<unknown>, RegExp][] = [
    [
      items(policy).diff(
        [
          { id: 'a', value: '1' },
          { id: 'a', value: '2' },
        ],
        null,
      ),
      /Snapshot items returned id a twice in one scan/,
    ],
    [
      new SnapshotDifferential<{ readonly id: Uint8Array }>({
        name: 'blobs',
        primaryKey: ['id'],
        key: (record) => [record.id],
        policy,
      }).diff(
        [{ id: new Uint8Array([1, 255]) }, { id: Buffer.from([1, 255]) }],
        null,
      ),
      /Snapshot blobs returned id bytes 01ff twice in one scan/,
    ],
    [
      items(policy).diffGroups(
        [group('g', 'v1', []), group('g', 'v1', [])],
        SnapshotDifferential.noGroups,
      ),
      /Snapshot items returned group g twice in one scan/,
    ],
    [
      items(policy).diffGroups(
        [
          { key: 'g', failed: true },
          { key: 'g', failed: true },
        ],
        SnapshotDifferential.noGroups,
      ),
      /Snapshot items returned group g twice in one scan/,
    ],
    [
      items(policy).diffGroups(
        [{ key: 'g', failed: true }, group('g', 'v1', [])],
        SnapshotDifferential.noGroups,
      ),
      /Snapshot items returned group g twice in one scan/,
    ],
    [
      items(policy).diffGroups(
        [{ key: 'g', kept: true }],
        SnapshotDifferential.noGroups,
      ),
      /Snapshot items kept group g, which its snapshot does not have/,
    ],
    [
      loose.diff([{ id: 'a', value: undefined }], null),
      /must be losslessly JSON serializable/,
    ],
    [
      items(policy).diff([], { snapshot: { '["a"]': 1 } }),
      /Snapshot items state is not a saved snapshot/,
    ],
    [
      items(policy).diff([], { snapshot: {}, listed: [1] }),
      /Snapshot items state is not a saved snapshot/,
    ],
  ];

  for (const [diff, message] of failures)
    await assert.rejects(Array.fromAsync(diff), message);
});

test('a grouped scan reads its saved snapshot where it lies, so a large snapshot diffs in a heap a few times its size', async (t) => {
  // A mailbox of 50,000 messages with 10 headers each saves about 41 MB of
  // state, one JSON row for each group. The second scan lists every message
  // but the first unchanged and one new message, as a mailbox does between
  // two syncs, in a process whose heap the test caps. Diffing it fits in
  // 144 MB when savedGroups keeps each group's snapshot where the parsed row
  // holds it, and fails at 176 MB when it copies that snapshot. Each scan
  // runs in a function, since a top-level for await keeps its finished
  // generator, and with it a whole scan.
  const program = `
    import { ClosedWorld, SnapshotDifferential } from ${JSON.stringify(import.meta.resolve('./index.ts'))};
    const headers = new SnapshotDifferential({
      name: 'headers',
      primaryKey: ['id'],
      key: (record) => [record.id],
      policy: new ClosedWorld(),
    });
    function* mailbox(first, last) {
      for (let message = first; message <= last; message++)
        yield {
          key: 'message-' + message,
          fingerprint: 'v1',
          *records() {
            for (let header = 0; header < 10; header++)
              yield { id: '<' + message + '.' + header + '@mail.example.com>', value: 'value ' + header + ' of ' + message };
          },
        };
    }
    // The rows a store keeps of the first scan: the JSON of each group put.
    async function saved() {
      for await (const change of headers.diffGroups(mailbox(0, 49_999), SnapshotDifferential.noGroups))
        if (change.type === 'state')
          return new Map([...change.state.changes.groups.put].map(([key, group]) => [key, JSON.stringify(group)]));
    }
    async function snapshot() {
      const rows = await saved();
      return headers.savedGroups({
        groups: new Map([...rows].map(([key, row]) => [key, JSON.parse(row)])),
        unknown: new Map(),
        listed: new Map(),
      });
    }
    async function changes(snapshot) {
      const counts = { inserts: 0, updates: 0, deletes: 0 };
      for await (const change of headers.diffGroups(mailbox(1, 50_000), snapshot))
        if (change.type === 'insert') counts.inserts++;
        else if (change.type === 'update') counts.updates++;
        else if (change.type === 'delete') counts.deletes++;
      return counts;
    }
    process.stdout.write(JSON.stringify(await changes(await snapshot())));
  `;

  const { stdout } = await execFileAsync(
    process.execPath,
    ['--max-old-space-size=176', '--input-type=module', '--eval', program],
    // The test bounds memory, not time: the test's own limit ends the child,
    // so a loaded machine is slower but not wrong (#3476).
    { signal: t.signal },
  );

  assert.deepEqual(JSON.parse(stdout), {
    inserts: 10,
    updates: 0,
    deletes: 10,
  });
});

test("a caller's fingerprint decides what changed, and an update gives the fingerprint that the snapshot saved", async () => {
  type Row = {
    readonly id: string;
    readonly title: string;
    readonly seen: number;
  };
  const rows = new SnapshotDifferential<Row>({
    name: 'rows',
    primaryKey: ['id'],
    key: (row) => [row.id],
    // The title alone: a change of seen is no change.
    fingerprint: (row) => `title:${row.title}`,
    policy: new ClosedWorld(),
  });
  const run = async (records: Row[], state: unknown) => {
    const updates: { id: string; saved: string }[] = [];
    let saved: unknown = null;
    for await (const change of rows.diff(records, state))
      if (change.type === 'state')
        saved = JSON.parse(JSON.stringify(change.state));
      else if (change.type === 'update')
        updates.push({ id: change.record.id, saved: change.savedFingerprint });
    return { updates, saved };
  };
  const first = await run(
    [
      { id: 'a', title: 'Plan', seen: 0 },
      { id: 'b', title: 'Draft', seen: 0 },
    ],
    null,
  );

  const second = await run(
    [
      { id: 'a', title: 'Plan', seen: 1 },
      { id: 'b', title: 'Final', seen: 0 },
    ],
    first.saved,
  );

  assert.deepEqual(second.updates, [{ id: 'b', saved: 'title:Draft' }]);
});
