import assert from 'node:assert/strict';

import { suite, test } from '@zukhruf/parameterized-test';

import {
  CheckpointFencedError,
  type CheckpointStore,
  ConsumerGroup,
  type Format,
} from '../../index.ts';
import { position, text } from '../formats.ts';

/**
 * A store under test: `open` gives a new, empty store, and its disposal frees
 * it. Each store runs this contract from its own tests.
 */
export type StoreSubject<W> = {
  readonly name: string;
  open(): Promise<AsyncDisposable & { readonly store: CheckpointStore<W> }>;
};

const inbox = { stream: 'messages', partition: 'inbox' };
const archive = { stream: 'messages', partition: 'archive' };
const contacts = { stream: 'contacts', partition: 'inbox' };

/** The rules of ADRs 0003 to 0009 that each checkpoint store keeps. */
export function checkpointStoreContract<W>(subject: StoreSubject<W>): void {
  suite(subject.name, () => {
    test('a commit of a claim that a newer claim replaced throws CheckpointFencedError, and the newer claim keeps what it committed', async () => {
      await using opened = await subject.open();
      const group = new ConsumerGroup('copy', opened.store);
      const older = await group.claim(inbox, position);
      older.state('seen', text).set('a', 'old');
      const newer = await group.claim(inbox, position);
      newer.state('seen', text).set('a', 'new');
      await newer.commit(2);

      const fenced = (error: unknown) => {
        assert.ok(error instanceof CheckpointFencedError);
        assert.deepEqual(error.key, { consumerGroup: 'copy', ...inbox });
        assert.equal(error.epoch.value, older.epoch.value);
        return true;
      };
      await assert.rejects(older.commit(1), fenced);
      await assert.rejects(older.commit(1), fenced);

      const reader = await new ConsumerGroup('copy', opened.store).claim(
        inbox,
        position,
      );
      assert.deepEqual(reader.checkpoint, { position: 2, checkpointId: 1 });
      assert.equal(await reader.state('seen', text).get('a'), 'new');
    });

    test('a second claim of a live partition resolves at once with a newer epoch', async () => {
      await using opened = await subject.open();
      const group = new ConsumerGroup('copy', opened.store);

      const first = await group.claim(inbox, position);
      const second = await group.claim(inbox, position);

      assert.ok(second.epoch.isNewerThan(first.epoch));
    });

    test('a reset of one partition fences its owner, gives a fresh partition with a newer epoch, and keeps the other partitions', async () => {
      await using opened = await subject.open();
      const group = new ConsumerGroup('copy', opened.store);
      const owner = await group.claim(inbox, position);
      owner.state('seen', text).set('a', 'inbox');
      await owner.commit(1);
      const neighbour = await group.claim(archive, position);
      neighbour.state('seen', text).set('a', 'archive');
      await neighbour.commit(9);

      await group.reset(inbox);

      await assert.rejects(owner.commit(2), CheckpointFencedError);
      const fresh = await group.claim(inbox, position);
      assert.equal(fresh.checkpoint, undefined);
      assert.equal(await fresh.state('seen', text).get('a'), undefined);
      assert.deepEqual(
        await Array.fromAsync(fresh.state('seen', text).entries()),
        [],
      );
      assert.ok(fresh.epoch.isNewerThan(owner.epoch));
      const kept = await group.claim(archive, position);
      assert.deepEqual(kept.checkpoint, { position: 9, checkpointId: 1 });
      assert.equal(await kept.state('seen', text).get('a'), 'archive');
    });

    test('a reset of a stream removes each of its partitions, fences each owner, and keeps the other streams', async () => {
      await using opened = await subject.open();
      const group = new ConsumerGroup('copy', opened.store);
      const owners = [];
      for (const partition of [inbox, archive, contacts]) {
        const owner = await group.claim(partition, position);
        owner.state('seen', text).set('a', partition.partition);
        await owner.commit(1);
        owners.push(owner);
      }
      const [inboxOwner, archiveOwner] = owners;
      assert.ok(inboxOwner !== undefined && archiveOwner !== undefined);

      await group.reset({ stream: 'messages' });

      await assert.rejects(inboxOwner.commit(2), CheckpointFencedError);
      await assert.rejects(archiveOwner.commit(2), CheckpointFencedError);
      const freshInbox = await group.claim(inbox, position);
      assert.equal(freshInbox.checkpoint, undefined);
      assert.equal(await freshInbox.state('seen', text).get('a'), undefined);
      const freshArchive = await group.claim(archive, position);
      assert.equal(freshArchive.checkpoint, undefined);
      assert.equal(await freshArchive.state('seen', text).get('a'), undefined);
      const kept = await group.claim(contacts, position);
      assert.deepEqual(kept.checkpoint, { position: 1, checkpointId: 1 });
      assert.equal(await kept.state('seen', text).get('a'), 'inbox');
    });

    test('a reset of a partition that has no checkpoint resolves and changes nothing', async () => {
      await using opened = await subject.open();
      const group = new ConsumerGroup('copy', opened.store);
      const owner = await group.claim(contacts, position);
      await owner.commit(3);

      await group.reset(inbox);
      await group.reset({ stream: 'never' });

      assert.deepEqual(
        (await Array.fromAsync(group.list())).map(({ stream }) => stream),
        ['contacts'],
      );
      const afterReset = await group.claim(inbox, position);
      const untouched = await group.claim(
        { stream: 'messages', partition: 'drafts' },
        position,
      );
      assert.equal(afterReset.checkpoint, undefined);
      assert.equal(afterReset.epoch.value, untouched.epoch.value);
      assert.deepEqual((await group.claim(contacts, position)).checkpoint, {
        position: 3,
        checkpointId: 1,
      });
    });

    test('a fresh partition has no checkpoint and empty map states', async () => {
      await using opened = await subject.open();

      const context = await new ConsumerGroup('copy', opened.store).claim(
        inbox,
        position,
      );

      assert.equal(context.checkpoint, undefined);
      const seen = context.state('seen', text);
      assert.equal(await seen.get('a'), undefined);
      assert.equal(await seen.has('a'), false);
      assert.deepEqual(await Array.fromAsync(seen.entries()), []);
    });

    test('a new consumer group over the store restores the committed position and map states, and each commit gives the next checkpoint id', async () => {
      await using opened = await subject.open();
      const first = await new ConsumerGroup('copy', opened.store).claim(
        inbox,
        position,
      );
      first.state('seen', text).set('a', 'x');

      const committed = await first.commit(7);

      assert.deepEqual(committed, { position: 7, checkpointId: 1 });
      assert.equal(first.checkpoint, undefined);
      const restored = await new ConsumerGroup('copy', opened.store).claim(
        inbox,
        position,
      );
      assert.deepEqual(restored.checkpoint, { position: 7, checkpointId: 1 });
      assert.equal(await restored.state('seen', text).get('a'), 'x');
      assert.deepEqual(await restored.commit(8), {
        position: 8,
        checkpointId: 2,
      });
    });

    test('decode gets the version that the commit wrote, for the position and for each map state value', async () => {
      await using opened = await subject.open();
      const writer = await new ConsumerGroup('copy', opened.store).claim(
        inbox,
        position,
      );
      writer.state('seen', text).set('a', 'old');
      await writer.commit(5);
      const versions: number[] = [];
      const positionV2: Format<{ readonly at: number }> = {
        version: 2,
        encode: (value) => value,
        decode: (version, json) => {
          versions.push(version);
          if (version === 1 && typeof json === 'number') return { at: json };
          throw new TypeError(`Unknown version ${version}`);
        },
      };
      const textV2: Format<{ readonly text: string }> = {
        version: 2,
        encode: (value) => value,
        decode: (version, json) => {
          versions.push(version);
          if (version === 1 && typeof json === 'string') return { text: json };
          throw new TypeError(`Unknown version ${version}`);
        },
      };

      const reader = await new ConsumerGroup('copy', opened.store).claim(
        inbox,
        positionV2,
      );

      assert.deepEqual(reader.checkpoint?.position, { at: 5 });
      assert.deepEqual(await reader.state('seen', textV2).get('a'), {
        text: 'old',
      });
      assert.deepEqual(versions, [1, 1]);
    });

    test('a clear and a commit leave no key, and a set after the clear in the same context stays', async () => {
      await using opened = await subject.open();
      const group = new ConsumerGroup('copy', opened.store);
      const first = await group.claim(inbox, position);
      first.state('seen', text).set('a', '1');
      first.state('seen', text).set('b', '2');
      await first.commit(1);
      const second = await group.claim(inbox, position);
      const seen = second.state('seen', text);

      seen.clear();
      seen.set('c', '3');
      await second.commit(2);

      const reader = await group.claim(inbox, position);
      assert.deepEqual(
        await Array.fromAsync(reader.state('seen', text).entries()),
        [['c', '3']],
      );
    });

    test('map states, partitions, streams and consumer groups keep their own values, and a claim of one key fences no other', async () => {
      await using opened = await subject.open();
      const copy = new ConsumerGroup('copy', opened.store);
      const other = new ConsumerGroup('other', opened.store);
      const keys = [
        { group: copy, partition: inbox, value: 'copy inbox' },
        { group: copy, partition: archive, value: 'copy archive' },
        { group: copy, partition: contacts, value: 'copy contacts' },
        { group: other, partition: inbox, value: 'other inbox' },
      ];
      const contexts = [];
      for (const key of keys) {
        contexts.push(await key.group.claim(key.partition, position));
      }
      for (const [index, context] of contexts.entries()) {
        const value = keys[index]?.value ?? '';
        context.state('seen', text).set('a', value);
        context.state('sent', text).set('a', `${value} sent`);
        await context.commit(index);
      }

      for (const [index, key] of keys.entries()) {
        const reader = await key.group.claim(key.partition, position);
        assert.deepEqual(reader.checkpoint, {
          position: index,
          checkpointId: 1,
        });
        assert.equal(await reader.state('seen', text).get('a'), key.value);
        assert.equal(
          await reader.state('sent', text).get('a'),
          `${key.value} sent`,
        );
      }
    });

    test('list gives each partition of the group that has a checkpoint, with its checkpoint id and epoch, and can name one stream', async () => {
      await using opened = await subject.open();
      const copy = new ConsumerGroup('copy', opened.store);
      const inboxOwner = await copy.claim(inbox, position);
      await inboxOwner.commit(1);
      const archiveOwner = await copy.claim(archive, position);
      await archiveOwner.commit(1);
      await archiveOwner.commit(2);
      const contactsOwner = await copy.claim(contacts, position);
      await contactsOwner.commit(1);
      await copy.claim({ stream: 'messages', partition: 'drafts' }, position);
      await (
        await new ConsumerGroup('other', opened.store).claim(inbox, position)
      ).commit(1);

      const byPartition = (
        a: { readonly stream: string; readonly partition: string },
        b: { readonly stream: string; readonly partition: string },
      ) =>
        a.stream.localeCompare(b.stream) ||
        a.partition.localeCompare(b.partition);
      const all = (await Array.fromAsync(copy.list())).toSorted(byPartition);
      const messages = (
        await Array.fromAsync(copy.list({ stream: 'messages' }))
      ).toSorted(byPartition);

      assert.deepEqual(
        all.map(({ stream, partition, checkpointId, epoch }) => [
          stream,
          partition,
          checkpointId,
          epoch.value,
        ]),
        [
          ['contacts', 'inbox', 1, contactsOwner.epoch.value],
          ['messages', 'archive', 2, archiveOwner.epoch.value],
          ['messages', 'inbox', 1, inboxOwner.epoch.value],
        ],
      );
      assert.deepEqual(
        messages.map(({ partition }) => partition),
        ['archive', 'inbox'],
      );
    });

    test('entries gives each key once, also past a thousand keys', async () => {
      await using opened = await subject.open();
      const group = new ConsumerGroup('copy', opened.store);
      const writer = await group.claim(inbox, position);
      const keys = Array.from({ length: 2001 }, (_, index) => `key ${index}`);
      for (const key of keys) writer.state('seen', text).set(key, key);
      await writer.commit(1);

      const reader = await group.claim(inbox, position);
      const read = await Array.fromAsync(reader.state('seen', text).entries());

      assert.deepEqual(read.map(([key]) => key).toSorted(), keys.toSorted());
    });

    test('a position and a map state value keep a NUL character and a lone surrogate', async () => {
      await using opened = await subject.open();
      const group = new ConsumerGroup('copy', opened.store);
      const odd = 'a\u0000b\ud800c';
      const textPosition: Format<string> = {
        version: 1,
        encode: (value) => value,
        decode: (_, json) => String(json),
      };
      const writer = await group.claim(inbox, textPosition);
      writer.state('seen', text).set(odd, odd);
      await writer.commit(odd);

      const reader = await group.claim(inbox, textPosition);

      assert.equal(reader.checkpoint?.position, odd);
      assert.equal(await reader.state('seen', text).get(odd), odd);
    });
  });
}
