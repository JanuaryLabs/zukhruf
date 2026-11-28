import assert from 'node:assert/strict';
// The default export is the module object itself, which mock.method can patch;
// syncBuiltinESMExports then copies the patch to the named exports.
import fsPromises, { readdir, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { type TestContext, describe } from 'node:test';

import { untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import { NodeCommand } from '@zukhruf/process';

import { type Settlement, watch } from '../../testing/watch.ts';
import { LockFileStore } from './lock-file-store.ts';
import { TicketQueueFileStore } from './ticket-queue-file-store.ts';

const stores = [
  {
    name: 'LockFileStore',
    url: new URL('./lock-file-store.ts', import.meta.url),
    create: (directory: string) =>
      new LockFileStore(directory, { clock: globalThis, pollInterval: 10 }),
    // Evicting a dead holder deletes its lock file.
    evictionStep: 'unlink',
  },
  {
    name: 'TicketQueueFileStore',
    url: new URL('./ticket-queue-file-store.ts', import.meta.url),
    create: (directory: string) =>
      new TicketQueueFileStore(directory, {
        clock: globalThis,
        pollInterval: 10,
      }),
    // Evicting a dead head renames a shorter queue over the lock file.
    evictionStep: 'rename',
  },
] as const;

/** Reads a watched promise's settlement now; a call is not narrowed by earlier asserts on `now`. */
const settlementOf = <T>(watched: { readonly now: Settlement<T> }) =>
  watched.now;

/** A process that takes the key and keeps it until it is killed. */
const holderSource = (storeUrl: URL, storeName: string, directory: string) => `
	import { ${storeName} } from ${JSON.stringify(storeUrl.href)};
	setInterval(() => {}, 1000);
	await new ${storeName}(${JSON.stringify(directory)}, { clock: globalThis, pollInterval: 10 }).acquire('product:42');
	process.send({ type: 'holding' });
`;

/**
 * A process that finds a dead holder and starts to evict it, but stops for
 * good at the file system step that removes the holder, as if it froze there.
 */
const evicterSource = (
  storeUrl: URL,
  storeName: string,
  directory: string,
  evictionStep: 'unlink' | 'rename',
) => `
	import fsPromises from 'node:fs/promises';
	import { syncBuiltinESMExports } from 'node:module';
	setInterval(() => {}, 1000);
	const step = fsPromises.${evictionStep};
	fsPromises.${evictionStep} = async (...args) => {
		if (String(args.at(-1) ?? '').endsWith('.lock') || String(args[0]).endsWith('.lock')) {
			process.send({ type: 'evicting' });
			await new Promise(() => {});
		}
		return step(...args);
	};
	syncBuiltinESMExports();
	const { ${storeName} } = await import(${JSON.stringify(storeUrl.href)});
	await new ${storeName}(${JSON.stringify(directory)}, { clock: globalThis, pollInterval: 10 }).acquire('product:42');
`;

/**
 * Records each eviction step this process takes on a lock file: the delete of
 * a dead holder's lock file, or the rename of a shorter queue over it. Every
 * call still reaches the real disk.
 */
function recordEvictions(t: TestContext) {
  const evictions: string[] = [];
  const unlink = fsPromises.unlink;
  const rename = fsPromises.rename;
  t.mock.method(fsPromises, 'unlink', async (path: string) => {
    if (path.endsWith('.lock')) evictions.push(`unlink ${path}`);
    return unlink(path);
  });
  t.mock.method(fsPromises, 'rename', async (from: string, to: string) => {
    if (to.endsWith('.lock')) evictions.push(`rename ${to}`);
    return rename(from, to);
  });
  syncBuiltinESMExports();
  return {
    evictions,
    [Symbol.dispose]() {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}

const journals = async (directory: string) =>
  (await readdir(directory)).filter((file) => file.endsWith('-journal'));

describe('A waiter that dies while it evicts a dead holder', () => {
  void test.each(stores, (store) =>
    test(`${store.name}: later waiters still evict the dead holder, one at a time`, async (t) => {
      // Arrange: a holder dies with the key, and a waiter freezes in the middle of evicting it.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using holder = await new NodeCommand(
        holderSource(store.url, store.name, directory.path),
        { name: 'holder', env: process.env, clock: globalThis },
      ).start({ ready: { message: 'holding' }, signal: t.signal });
      holder.process.signal('SIGKILL');
      await holder.process.ended;
      await using evicter = await new NodeCommand(
        evicterSource(
          store.url,
          store.name,
          directory.path,
          store.evictionStep,
        ),
        { name: 'evicter', env: process.env, clock: globalThis },
      ).start({ ready: { message: 'evicting' }, signal: t.signal });
      const first = store.create(directory.path);
      const second = store.create(directory.path);

      // Act + Assert: while the evicter is inside its eviction, nobody else evicts or gets the key.
      {
        using spy = recordEvictions(t);
        assert.equal(await first.tryAcquire('product:42'), undefined);
        assert.deepEqual(
          spy.evictions,
          [],
          'Only one waiter at a time may evict a dead holder',
        );
      }

      // Act: the frozen evicter dies too.
      evicter.process.signal('SIGKILL');
      await evicter.process.ended;
      assert.deepEqual(
        await journals(directory.path),
        [],
        'A waiter that dies while it evicts must leave no journal behind',
      );
      const firstAcquire = first.acquire('product:42', { signal: t.signal });
      const secondAcquire = second.acquire('product:42', { signal: t.signal });
      const firstLease = watch(firstAcquire);
      const secondLease = watch(secondAcquire);

      // Assert: the dead holder is evicted after all, and the key goes to one waiter at a time.
      // A dead evicter must not keep the dead holder in place.
      await untilAborted(Promise.race([firstAcquire, secondAcquire]), t.signal);
      const [winner, loser, loserAcquire] =
        firstLease.now.status !== 'pending'
          ? [firstLease, secondLease, secondAcquire]
          : [secondLease, firstLease, firstAcquire];
      const won = settlementOf(winner);
      assert.ok(
        won.status === 'fulfilled',
        `The first waiter ended ${won.status}`,
      );
      assert.equal(
        loser.now.status,
        'pending',
        'Two waiters must not hold the key at once',
      );
      await won.value[Symbol.asyncDispose]();
      // The other waiter must get the key once it is released.
      await untilAborted(
        loserAcquire.catch(() => {}),
        t.signal,
      );
      const lost = settlementOf(loser);
      assert.ok(
        lost.status === 'fulfilled',
        `The second waiter ended ${lost.status}`,
      );
      await lost.value[Symbol.asyncDispose]();
    }),
  );

  void test.each(stores, (store) =>
    test(`${store.name}: a reclaim file left by an older version fails the acquire with its name`, async (t) => {
      // Arrange: a holder dies with the key, and an older version's waiter died while it evicted it.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using holder = await new NodeCommand(
        holderSource(store.url, store.name, directory.path),
        { name: 'holder', env: process.env, clock: globalThis },
      ).start({ ready: { message: 'holding' }, signal: t.signal });
      holder.process.signal('SIGKILL');
      await holder.process.ended;
      const [lockFile] = (await readdir(directory.path)).filter((file) =>
        file.endsWith('.lock'),
      );
      assert.ok(lockFile, 'The holder must have left its lock file');
      // An older version wrote the reclaim file as JSON, not as a database: platform setup that no operation here exposes.
      const reclaim = join(directory.path, `${lockFile}.reclaim`);
      await writeFile(
        reclaim,
        JSON.stringify({ pid: 1, host: 'old', id: 'x' }),
      );

      // Act
      const acquiring = store
        .create(directory.path)
        .acquire('product:42', { signal: t.signal });

      // Assert: the waiter says which file is in the way instead of waiting forever.
      await assert.rejects(acquiring, (error: unknown) => {
        assert.ok(Error.isError(error));
        assert.match(error.message, /older version/);
        // The message quotes the path as JSON, which doubles each Windows backslash.
        assert.ok(
          error.message.includes(JSON.stringify(reclaim)),
          error.message,
        );
        return true;
      });
    }),
  );
});
