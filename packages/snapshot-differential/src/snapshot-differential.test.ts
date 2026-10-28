import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

import {
  ClosedWorld,
  Coverage,
  type DeletionPolicy,
  Retention,
  type SnapshotChange,
  SnapshotDifferential,
  type SnapshotGroup,
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
      null,
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
      first.state,
    ),
  );
  // three vanishes, outside what the scan covers.
  const evicted = await changes(
    items(new Coverage(({ key }) => key.id !== 'b')).diffGroups(
      [unread, group('two', 'v2', [])],
      moved.state,
    ),
  );
  const covered = await changes(
    items(everything).diffGroups(
      [unread, group('two', 'v2', [])],
      evicted.state,
    ),
  );

  assert.deepEqual([first.inserted, first.updated], [['a', 'b'], []]);
  assert.deepEqual([moved.inserted, moved.updated], [[], []]);
  assert.deepEqual(moved.deleted, []);
  assert.deepEqual(evicted.deleted, []);
  assert.deepEqual(Object.keys(evicted.state.unknown ?? {}), ['["b"]']);
  assert.deepEqual(covered.deleted, ['b']);
  assert.equal(covered.state.unknown, undefined);
});

test('a kept group keeps its saved fingerprint and records unread, so the scan deletes nothing and saves the same state', async () => {
  const policy = new ClosedWorld();
  const first = await changes(
    items(policy).diffGroups(
      [
        group('one', 'v1', [{ id: 'a', value: '1' }]),
        group('two', 'v1', [{ id: 'b', value: '1' }]),
      ],
      null,
    ),
  );

  const kept = await changes(
    items(policy).diffGroups(
      [{ key: 'one', kept: true }, group('two', 'v1', [])],
      first.state,
    ),
  );

  assert.deepEqual([kept.inserted, kept.updated], [[], []]);
  assert.deepEqual(kept.deleted, []);
  assert.deepEqual(kept.state, first.state);
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
      null,
    ),
  );

  const first = await changes(
    items(policy).diffGroups([{ key: 'one', kept: true }], loaded.state, {
      continues: true,
    }),
  );
  const last = await changes(
    items(policy).diffGroups(
      [group('two', 'v1', [{ id: 'b', value: '1' }])],
      first.state,
    ),
  );

  assert.deepEqual(last.deleted, ['c']);
  assert.deepEqual(last.state.groups.one, loaded.state.groups.one);
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
      null,
    ),
  );

  const first = await changes(
    items(policy).diffGroups(
      [group('one', 'v2', [{ id: 'a', value: '2' }])],
      loaded.state,
      { continues: true },
    ),
  );
  const last = await changes(
    items(policy).diffGroups(
      [group('two', 'v1', [{ id: 'b', value: '1' }])],
      first.state,
    ),
  );

  assert.deepEqual([first.inserted, first.updated], [[], ['a']]);
  assert.deepEqual(first.deleted, []);
  assert.deepEqual(last.deleted, ['c']);
  assert.deepEqual(Object.keys(last.state.groups), ['one', 'two']);
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
      null,
    ),
  );

  const first = await changes(
    items(policy).diffGroups(
      [group('one', 'v2', [{ id: 'a', value: '1' }])],
      loaded.state,
      { continues: true },
    ),
  );
  const last = await changes(
    items(policy).diffGroups([group('two', 'v1', [])], first.state),
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
      null,
    ),
  );
  // b vanishes where the scan cannot tell: unknown.
  const uncovered = await changes(
    items(new Coverage(() => false)).diffGroups(
      [group('one', 'v1', [])],
      loaded.state,
    ),
  );

  const part = await changes(
    items(new Coverage(() => true)).diffGroups(
      [group('one', 'v1', [])],
      uncovered.state,
      { continues: true },
    ),
  );
  const last = await changes(
    items(new Coverage(() => true)).diffGroups(
      [group('one', 'v1', [])],
      part.state,
    ),
  );

  assert.deepEqual(Object.keys(uncovered.state.unknown ?? {}), ['["b"]']);
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
      null,
    ),
  );
  const first = await changes(
    items(policy).diffGroups([group('two', 'v1', [])], loaded.state, {
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
      first.state,
    ),
  );

  // b leaves one; two, unchanged and unread, must not still vouch for it.
  const removed = await changes(
    items(policy).diffGroups(
      [group('one', 'v3', [{ id: 'a', value: '1' }]), group('two', 'v1', [])],
      moved.state,
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
      null,
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
      first.state,
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
      null,
    ),
  );
  const evicted = await changes(
    items(outside).diff([{ id: 'a', value: '1' }], loaded.state),
  );
  const groupsEvicted = await changes(
    items(outside).diffGroups(
      [group('one', 'v1', [{ id: 'a', value: '1' }])],
      groupsLoaded.state,
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
      groupsEvicted.state,
    ),
  );

  assert.deepEqual(Object.keys(groupsEvicted.state.unknown ?? {}), ['["b"]']);
  assert.deepEqual([returned.inserted, returned.updated], [[], ['b']]);
  assert.deepEqual(
    [groupsReturned.inserted, groupsReturned.updated],
    [[], ['b']],
  );
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

test('a record that holds a value JSON cannot hold with no change, other than bytes, fails', async () => {
  const loose = new SnapshotDifferential<Record<string, unknown>>({
    name: 'loose',
    primaryKey: ['id'],
    key: () => ['a'],
    policy: new ClosedWorld(),
  });

  for (const value of [
    new Uint16Array([1]),
    new Uint8ClampedArray([1]),
    new Date(0),
    -0,
    Number.NaN,
    { inner: undefined },
  ])
    await assert.rejects(
      Array.fromAsync(loose.diff([{ id: 'a', value }], null)),
      /Snapshot loose records must be losslessly JSON serializable, or bytes/,
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
        null,
      ),
      /Snapshot items returned group g twice in one scan/,
    ],
    [
      items(policy).diffGroups([{ key: 'g', kept: true }], null),
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

test('a grouped scan reads its saved snapshot where it lies, so a large snapshot diffs in a heap a few times its size', async () => {
  // A mailbox of 50,000 messages with 10 headers each saves about 41 MB of
  // state. The second scan lists every message but the first unchanged and
  // one new message, as a mailbox does between two syncs, in a process whose
  // heap the test caps. Diffing it takes about 160 MB when the scan reads
  // the state the caller parsed where it lies, and over 192 MB when it
  // copies that state. Each scan runs in a function, since a top-level
  // for await keeps its finished generator, and with it a whole scan.
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
    async function saved() {
      for await (const change of headers.diffGroups(mailbox(0, 49_999), null))
        if (change.type === 'state') return JSON.stringify(change.state);
    }
    async function changes(state) {
      const counts = { inserts: 0, updates: 0, deletes: 0 };
      for await (const change of headers.diffGroups(mailbox(1, 50_000), state))
        if (change.type === 'insert') counts.inserts++;
        else if (change.type === 'update') counts.updates++;
        else if (change.type === 'delete') counts.deletes++;
      return counts;
    }
    process.stdout.write(JSON.stringify(await changes(JSON.parse(await saved()))));
  `;

  const { stdout } = await execFileAsync(
    process.execPath,
    ['--max-old-space-size=176', '--input-type=module', '--eval', program],
    { timeout: 50_000 },
  );

  assert.deepEqual(JSON.parse(stdout), {
    inserts: 10,
    updates: 0,
    deletes: 10,
  });
});
