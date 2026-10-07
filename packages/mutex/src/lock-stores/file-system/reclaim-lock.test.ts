import assert from 'node:assert/strict';
// The default export is the module object itself, which mock.method can patch;
// syncBuiltinESMExports then copies the patch to the named exports.
import fsPromises, { readdir, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { describe, mock, test } from 'node:test';

import { scratchDirectory } from '../../testing/scratch-directory.ts';
import { waitUntil } from '../../testing/wait-until.ts';
import { type Settlement, watch } from '../../testing/watch.ts';
import { startWorker } from '../../testing/worker-process.ts';
import { LockFileStore } from './lock-file-store.ts';
import { TicketQueueFileStore } from './ticket-queue-file-store.ts';

const stores = [
  {
    name: 'LockFileStore',
    url: new URL('./lock-file-store.ts', import.meta.url),
    create: (directory: string) =>
      new LockFileStore(directory, { pollInterval: 10 }),
    // Evicting a dead holder deletes its lock file.
    evictionStep: 'unlink',
  },
  {
    name: 'TicketQueueFileStore',
    url: new URL('./ticket-queue-file-store.ts', import.meta.url),
    create: (directory: string) =>
      new TicketQueueFileStore(directory, { pollInterval: 10 }),
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
	await new ${storeName}(${JSON.stringify(directory)}, { pollInterval: 10 }).acquire('product:42');
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
	await new ${storeName}(${JSON.stringify(directory)}, { pollInterval: 10 }).acquire('product:42');
`;

/**
 * Records each eviction step this process takes on a lock file: the delete of
 * a dead holder's lock file, or the rename of a shorter queue over it. Every
 * call still reaches the real disk.
 */
function recordEvictions() {
  const evictions: string[] = [];
  const unlink = fsPromises.unlink;
  const rename = fsPromises.rename;
  mock.method(fsPromises, 'unlink', async (path: string) => {
    if (path.endsWith('.lock')) evictions.push(`unlink ${path}`);
    return unlink(path);
  });
  mock.method(fsPromises, 'rename', async (from: string, to: string) => {
    if (to.endsWith('.lock')) evictions.push(`rename ${to}`);
    return rename(from, to);
  });
  syncBuiltinESMExports();
  return {
    evictions,
    [Symbol.dispose]() {
      mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}

const journals = async (directory: string) =>
  (await readdir(directory)).filter((file) => file.endsWith('-journal'));

describe('A waiter that dies while it evicts a dead holder', () => {
  for (const store of stores) {
    test(
      `${store.name}: later waiters still evict the dead holder, one at a time`,
      { timeout: 20_000 },
      async (t) => {
        // Arrange: a holder dies with the key, and a waiter freezes in the middle of evicting it.
        await using directory = await scratchDirectory();
        await using holder = startWorker(
          holderSource(store.url, store.name, directory.path),
          'holder',
        );
        await waitUntil(t, () => holder.has('holding'), holder.stderr, 5000);
        holder.child.kill('SIGKILL');
        await holder.closed;
        await using evicter = startWorker(
          evicterSource(
            store.url,
            store.name,
            directory.path,
            store.evictionStep,
          ),
          'evicter',
        );
        await waitUntil(t, () => evicter.has('evicting'), evicter.stderr, 5000);
        const first = store.create(directory.path);
        const second = store.create(directory.path);

        // Act + Assert: while the evicter is inside its eviction, nobody else evicts or gets the key.
        {
          using spy = recordEvictions();
          assert.equal(await first.tryAcquire('product:42'), undefined);
          assert.deepEqual(
            spy.evictions,
            [],
            'Only one waiter at a time may evict a dead holder',
          );
        }

        // Act: the frozen evicter dies too.
        evicter.child.kill('SIGKILL');
        await evicter.closed;
        assert.deepEqual(
          await journals(directory.path),
          [],
          'A waiter that dies while it evicts must leave no journal behind',
        );
        const firstLease = watch(
          first.acquire('product:42', { signal: AbortSignal.timeout(5000) }),
        );
        const secondLease = watch(
          second.acquire('product:42', { signal: AbortSignal.timeout(5000) }),
        );

        // Assert: the dead holder is evicted after all, and the key goes to one waiter at a time.
        await waitUntil(
          t,
          () =>
            firstLease.now.status !== 'pending' ||
            secondLease.now.status !== 'pending',
          'A dead evicter must not keep the dead holder in place',
          5000,
        );
        const [winner, loser] =
          firstLease.now.status !== 'pending'
            ? [firstLease, secondLease]
            : [secondLease, firstLease];
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
        await waitUntil(
          t,
          () => loser.now.status !== 'pending',
          'The other waiter must get the key once it is released',
          5000,
        );
        const lost = settlementOf(loser);
        assert.ok(
          lost.status === 'fulfilled',
          `The second waiter ended ${lost.status}`,
        );
        await lost.value[Symbol.asyncDispose]();
      },
    );
  }

  for (const store of stores) {
    test(
      `${store.name}: a reclaim file left by an older version fails the acquire with its name`,
      { timeout: 20_000 },
      async (t) => {
        // Arrange: a holder dies with the key, and an older version's waiter died while it evicted it.
        await using directory = await scratchDirectory();
        await using holder = startWorker(
          holderSource(store.url, store.name, directory.path),
          'holder',
        );
        await waitUntil(t, () => holder.has('holding'), holder.stderr, 5000);
        holder.child.kill('SIGKILL');
        await holder.closed;
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
          .acquire('product:42', { signal: AbortSignal.timeout(5000) });

        // Assert: the waiter says which file is in the way instead of waiting forever.
        await assert.rejects(acquiring, (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /older version/);
          // The message quotes the path as JSON, which doubles each Windows backslash.
          assert.ok(
            error.message.includes(JSON.stringify(reclaim)),
            error.message,
          );
          return true;
        });
      },
    );
  }
});
