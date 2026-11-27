import assert from 'node:assert/strict';

import type { FencingToken } from '@zukhruf/fencing';
import { test } from '@zukhruf/parameterized-test';

import {
  type CheckpointKey,
  type CheckpointStore,
  type CheckpointSummary,
  ConsumerGroup,
  type Format,
  IncompatibleCheckpointError,
  MemoryCheckpointStore,
  type PartitionContext,
  type SignalOption,
  type StateChanges,
  type StoredCheckpoint,
  type StoredValue,
} from './index.ts';
import { position, text } from './testing/formats.ts';

const inbox = { stream: 'messages', partition: 'inbox' };

type Write = (transaction: string) => void;

type Owner = PartitionContext<number, Write>;

/**
 * A store that a host writes over the memory store, as the README's "Write
 * your own store" says. It can throw from one method, and it records what
 * each commit gets. It gives no signal to the memory store, so that only the
 * package's own checks stop an aborted call.
 */
class HostStore implements CheckpointStore<Write> {
  readonly commits: {
    readonly checkpoint: StoredCheckpoint;
    readonly changes: StateChanges;
    readonly write: Write | undefined;
    readonly signal: AbortSignal | undefined;
  }[] = [];
  readonly #memory = new MemoryCheckpointStore();
  readonly #failures = new Map<string, unknown>();

  /** The next call of `method` throws `error`, once. */
  failNext(method: keyof CheckpointStore<Write>, error: unknown): void {
    this.#failures.set(method, error);
  }

  #fail(method: keyof CheckpointStore<Write>): void {
    if (!this.#failures.has(method)) return;
    const error = this.#failures.get(method);
    this.#failures.delete(method);
    throw error;
  }

  async claim(
    key: CheckpointKey,
    options?: SignalOption,
  ): Promise<FencingToken> {
    this.#fail('claim');
    return this.#memory.claim(key);
  }

  async read(
    key: CheckpointKey,
    options?: SignalOption,
  ): Promise<StoredCheckpoint | undefined> {
    this.#fail('read');
    return this.#memory.read(key);
  }

  async get(
    key: CheckpointKey,
    state: string,
    keys: readonly string[],
    options?: SignalOption,
  ): Promise<ReadonlyMap<string, StoredValue>> {
    this.#fail('get');
    return this.#memory.get(key, state, keys);
  }

  async *scan(
    key: CheckpointKey,
    state: string,
    options?: SignalOption,
  ): AsyncIterable<readonly [string, StoredValue]> {
    this.#fail('scan');
    yield* this.#memory.scan(key, state);
  }

  async commit(
    key: CheckpointKey,
    epoch: FencingToken,
    checkpoint: StoredCheckpoint,
    changes: StateChanges,
    options?: SignalOption & { readonly write?: Write },
  ): Promise<void> {
    this.#fail('commit');
    await this.#memory.commit(key, epoch, checkpoint, changes);
    this.commits.push({
      checkpoint,
      changes,
      write: options?.write,
      signal: options?.signal,
    });
  }

  async *list(
    consumerGroup: string,
    options?: SignalOption & { readonly stream?: string },
  ): AsyncIterable<CheckpointSummary> {
    this.#fail('list');
    yield* this.#memory.list(consumerGroup, {
      ...(options?.stream === undefined ? {} : { stream: options.stream }),
    });
  }

  async reset(
    consumerGroup: string,
    target: { readonly stream: string; readonly partition?: string },
    options?: SignalOption,
  ): Promise<void> {
    this.#fail('reset');
    await this.#memory.reset(consumerGroup, target);
  }
}

void test.each(
  [
    {
      method: 'claim',
      label: 'claim',
      call: (group: ConsumerGroup<Write>) => group.claim(inbox, position),
    },
    {
      method: 'read',
      label: 'read inside a claim',
      call: (group: ConsumerGroup<Write>) => group.claim(inbox, position),
    },
    {
      method: 'get',
      label: 'get',
      call: async (group: ConsumerGroup<Write>) =>
        (await group.claim(inbox, position)).state('seen', text).get('a'),
    },
    {
      method: 'scan',
      label: 'scan',
      call: async (group: ConsumerGroup<Write>) =>
        Array.fromAsync(
          (await group.claim(inbox, position)).state('seen', text).entries(),
        ),
    },
    {
      method: 'list',
      label: 'list',
      call: (group: ConsumerGroup<Write>) => Array.fromAsync(group.list()),
    },
    {
      method: 'reset',
      label: 'reset',
      call: (group: ConsumerGroup<Write>) => group.reset(inbox),
    },
  ] as const,
  ({ method, label, call }) =>
    test(`an error of the store's ${label} reaches the caller as it is`, async () => {
      const store = new HostStore();
      const error = new Error(`the ${method} of the driver failed`);
      store.failNext(method, error);

      await assert.rejects(call(new ConsumerGroup('copy', store)), (thrown) => {
        assert.equal(thrown, error);
        return true;
      });
    }),
);

test('a commit that the store refuses rejects with its error, and a retry commits the kept changes', async () => {
  const store = new HostStore();
  const group = new ConsumerGroup('copy', store);
  const context = await group.claim(inbox, position);
  context.state('seen', text).set('a', 'kept');
  const error = new Error('the connection closed');
  store.failNext('commit', error);

  await assert.rejects(context.commit(1), (thrown) => {
    assert.equal(thrown, error);
    return true;
  });
  assert.deepEqual(await Array.fromAsync(group.list()), []);
  assert.equal(context.checkpoint, undefined);

  assert.deepEqual(await context.commit(1), { position: 1, checkpointId: 1 });
  const reader = await group.claim(inbox, position);
  assert.equal(await reader.state('seen', text).get('a'), 'kept');
});

test('a commit whose signal aborted rejects with its reason, writes nothing, and a retry commits the kept changes', async () => {
  const store = new HostStore();
  const group = new ConsumerGroup('copy', store);
  const context = await group.claim(inbox, position);
  context.state('seen', text).set('a', 'kept');
  const reason = new Error('stopped');

  await assert.rejects(
    context.commit(1, { signal: AbortSignal.abort(reason) }),
    (thrown) => {
      assert.equal(thrown, reason);
      return true;
    },
  );
  assert.deepEqual(await Array.fromAsync(group.list()), []);

  await context.commit(1);
  const reader = await group.claim(inbox, position);
  assert.equal(await reader.state('seen', text).get('a'), 'kept');
});

test('a claim whose stored position decode cannot read rejects with IncompatibleCheckpointError, with the key, the version and the cause', async () => {
  const store = new MemoryCheckpointStore();
  await (
    await new ConsumerGroup('copy', store).claim(inbox, position)
  ).commit(1);
  const cause = new TypeError('version 1 is gone');
  const strict: Format<number> = {
    version: 2,
    encode: (value) => value,
    decode: () => {
      throw cause;
    },
  };

  await assert.rejects(
    new ConsumerGroup('copy', store).claim(inbox, strict),
    (error) => {
      assert.ok(error instanceof IncompatibleCheckpointError);
      assert.deepEqual(error.key, { consumerGroup: 'copy', ...inbox });
      assert.equal(error.version, 1);
      assert.equal(error.cause, cause);
      return true;
    },
  );
});

test('a map state read whose stored value decode cannot read rejects with IncompatibleCheckpointError, with the key, the version and the cause', async () => {
  const store = new MemoryCheckpointStore();
  const writer = await new ConsumerGroup('copy', store).claim(inbox, position);
  writer.state('seen', text).set('a', 'old');
  await writer.commit(1);
  const cause = new TypeError('version 1 is gone');
  const strict: Format<string> = {
    version: 2,
    encode: (value) => value,
    decode: () => {
      throw cause;
    },
  };
  const seen = (
    await new ConsumerGroup('copy', store).claim(inbox, position)
  ).state('seen', strict);

  const incompatible = (error: unknown) => {
    assert.ok(error instanceof IncompatibleCheckpointError);
    assert.deepEqual(error.key, { consumerGroup: 'copy', ...inbox });
    assert.equal(error.version, 1);
    assert.equal(error.cause, cause);
    return true;
  };
  await assert.rejects(seen.get('a'), incompatible);
  await assert.rejects(Array.fromAsync(seen.entries()), incompatible);
});

test('get, has and entries give the changes of the context over the committed values', async () => {
  const store = new MemoryCheckpointStore();
  const group = new ConsumerGroup('copy', store);
  const writer = await group.claim(inbox, position);
  writer.state('seen', text).set('a', '1');
  writer.state('seen', text).set('b', '2');
  await writer.commit(1);
  const seen = (await group.claim(inbox, position)).state('seen', text);

  seen.delete('a');
  seen.set('b', '22');
  seen.set('c', '3');

  assert.equal(await seen.get('a'), undefined);
  assert.equal(await seen.has('a'), false);
  assert.equal(await seen.get('b'), '22');
  assert.equal(await seen.has('c'), true);
  assert.deepEqual(
    (await Array.fromAsync(seen.entries())).toSorted(([a], [b]) =>
      a.localeCompare(b),
    ),
    [
      ['b', '22'],
      ['c', '3'],
    ],
  );

  seen.clear();
  seen.set('d', '4');

  assert.equal(await seen.get('b'), undefined);
  assert.equal(await seen.has('b'), false);
  assert.deepEqual(await Array.fromAsync(seen.entries()), [['d', '4']]);
});

test('each commit gives the store only the keys set, deleted or cleared since the last commit', async () => {
  const store = new HostStore();
  const context = await new ConsumerGroup('copy', store).claim(inbox, position);
  const seen = context.state('seen', text);
  const entries = (changes: StateChanges) => ({
    cleared: [...changes.cleared],
    deleted: [...changes.deleted].map(([name, keys]) => [name, [...keys]]),
    set: [...changes.set].map(([name, values]) => [name, [...values.keys()]]),
  });

  seen.set('a', '1');
  seen.set('b', '2');
  await context.commit(1);
  seen.set('c', '3');
  await context.commit(2);
  seen.delete('a');
  await context.commit(3);
  seen.clear();
  await context.commit(4);
  await context.commit(5);

  // A commit that skips the unchanged keys shows nothing to a reader: only the
  // store sees what each commit writes.
  assert.deepEqual(
    store.commits.map(({ changes }) => entries(changes)),
    [
      { cleared: [], deleted: [], set: [['seen', ['a', 'b']]] },
      { cleared: [], deleted: [], set: [['seen', ['c']]] },
      { cleared: [], deleted: [['seen', ['a']]], set: [] },
      { cleared: ['seen'], deleted: [], set: [] },
      { cleared: [], deleted: [], set: [] },
    ],
  );
  assert.deepEqual(
    store.commits.map(({ checkpoint }) => checkpoint.checkpointId),
    [1, 2, 3, 4, 5],
  );
});

test('a commit gives its write and its signal to the store', async () => {
  const store = new HostStore();
  const context = await new ConsumerGroup('copy', store).claim(inbox, position);
  const write: Write = () => {};
  const { signal } = new AbortController();

  await context.commit(1, { write, signal });

  assert.equal(store.commits[0]?.write, write);
  assert.equal(store.commits[0]?.signal, signal);
});

void test.each(
  [
    {
      call: 'claim',
      run: (_: Owner, group: ConsumerGroup<Write>, signal: AbortSignal) =>
        group.claim(inbox, position, { signal }),
    },
    {
      call: 'get',
      run: (owner: Owner, _: ConsumerGroup<Write>, signal: AbortSignal) =>
        owner.state('seen', text).get('a', { signal }),
    },
    {
      call: 'has',
      run: (owner: Owner, _: ConsumerGroup<Write>, signal: AbortSignal) =>
        owner.state('seen', text).has('a', { signal }),
    },
    {
      call: 'entries',
      run: (owner: Owner, _: ConsumerGroup<Write>, signal: AbortSignal) =>
        Array.fromAsync(owner.state('seen', text).entries({ signal })),
    },
    {
      call: 'list',
      run: (_: Owner, group: ConsumerGroup<Write>, signal: AbortSignal) =>
        Array.fromAsync(group.list({ signal })),
    },
    {
      call: 'reset',
      run: (_: Owner, group: ConsumerGroup<Write>, signal: AbortSignal) =>
        group.reset(inbox, { signal }),
    },
  ] as const,
  ({ call, run }) =>
    test(`an aborted signal rejects ${call} with its reason and changes nothing`, async () => {
      const store = new HostStore();
      const group = new ConsumerGroup('copy', store);
      const owner = await group.claim(inbox, position);
      owner.state('seen', text).set('a', 'kept');
      await owner.commit(1);
      const reason = new Error('stopped');

      await assert.rejects(
        run(owner, group, AbortSignal.abort(reason)),
        (thrown) => {
          assert.equal(thrown, reason);
          return true;
        },
      );

      assert.deepEqual(await owner.commit(2), { position: 2, checkpointId: 2 });
      const reader = await group.claim(inbox, position);
      assert.deepEqual(reader.checkpoint, { position: 2, checkpointId: 2 });
      assert.equal(await reader.state('seen', text).get('a'), 'kept');
    }),
);
