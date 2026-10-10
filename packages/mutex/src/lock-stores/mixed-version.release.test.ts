import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { Modes } from '../mutex/acquire-modes/modes.ts';
import { Mutex } from '../mutex/mutex.ts';
import { isRecord } from '../shared/is-record.ts';
import { scratchDirectory } from '../testing/scratch-directory.ts';
import { storeCases } from '../testing/store-cases.ts';
import { newProcessTimeout, waitUntil } from '../testing/wait-until.ts';
import { startWorker } from '../testing/worker-process.ts';

const run = promisify(execFile);

/** Long enough for a slow registry; a registry that never answers fails the file instead of hanging it. */
const downloadTimeout = 120_000;

/** npm is npm.cmd on Windows, and Node.js runs a .cmd file only through a shell. */
async function npm(args: string[]): Promise<string> {
  const { stdout } = await run('npm', args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: downloadTimeout,
  });
  return stdout;
}

/** A folder of this package's own, so another user of the machine cannot put a package there. */
const cache = fileURLToPath(
  new URL('../../node_modules/.cache/latest-release/', import.meta.url),
);

/** Whether `folder` holds the release `version` and each of its dependencies. */
async function isUnpacked(folder: string, version: string): Promise<boolean> {
  try {
    const manifest: unknown = JSON.parse(
      await readFile(join(folder, 'package', 'package.json'), 'utf8'),
    );
    if (
      !isRecord(manifest) ||
      manifest.name !== '@zukhruf/mutex' ||
      manifest.version !== version
    ) {
      return false;
    }
    const dependencies = isRecord(manifest.dependencies)
      ? Object.keys(manifest.dependencies)
      : [];
    for (const name of dependencies) {
      await access(
        join(folder, 'package', 'node_modules', name, 'package.json'),
      );
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The latest release of @zukhruf/mutex: what the other processes on a host
 * run while it upgrades to this source. It is unpacked once for each version,
 * with the published versions of its dependencies installed next to it. Its
 * dependencies, such as @zukhruf/election and @zukhruf/fencing, take part in
 * the protocol between processes: if they resolved to this workspace's
 * copies, both sides would run the same code, and a break in it would pass.
 */
async function latestRelease() {
  const version = (await npm(['view', '@zukhruf/mutex', 'version'])).trim();
  const unpacked = join(cache, version);
  if (!(await isUnpacked(unpacked, version))) {
    await rm(unpacked, { recursive: true, force: true });
    await mkdir(cache, { recursive: true });
    const draft = await mkdtemp(join(cache, 'download-'));
    try {
      const packed: unknown = JSON.parse(
        await npm([
          'pack',
          `@zukhruf/mutex@${version}`,
          '--json',
          '--ignore-scripts',
          '--pack-destination',
          draft,
        ]),
      );
      const filename =
        Array.isArray(packed) && isRecord(packed[0])
          ? packed[0].filename
          : undefined;
      if (typeof filename !== 'string') {
        throw new Error(`npm pack named no file: ${JSON.stringify(packed)}`);
      }
      await run('tar', ['-xzf', join(draft, filename), '-C', draft], {
        timeout: downloadTimeout,
      });
      // Only the release's own folder: never this workspace or its lockfile.
      await npm([
        'install',
        '--prefix',
        join(draft, 'package'),
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--workspaces=false',
      ]);
      // A rename is atomic, so a run that unpacks at the same time finds the whole package or none.
      await rename(draft, unpacked).catch((error: unknown) => {
        if (!isRecord(error) || error.code !== 'ENOTEMPTY') throw error;
      });
    } finally {
      await rm(draft, { recursive: true, force: true });
    }
  }
  return {
    version,
    url: pathToFileURL(join(unpacked, 'package', 'dist', 'index.js')).href,
  };
}

const release = await latestRelease().catch((error: unknown) => {
  throw new Error(
    'These tests download the latest release of @zukhruf/mutex with npm, and the download failed. They need the npm registry.',
    { cause: error },
  );
});

/**
 * Each store with the keys whose file names both versions must agree on, up
 * to the longest key that keeps its name. The limits are those of
 * file-lock-store.test.ts.
 */
const cases = [
  ...[
    { store: 'LockFileStore', longest: 204 },
    { store: 'TicketQueueFileStore', longest: 204 },
    { store: 'SqliteStore', longest: 208 },
  ].flatMap(({ store, longest }) =>
    ['orders/حساب.v2', 'k'.repeat(longest)].map((key) => ({ store, key })),
  ),
  // A socket store sends keys as JSON, so no length is special.
  { store: 'SocketStore', key: 'orders/حساب.v2' },
];

const label = (key: string) =>
  key.length > 32 ? `a key of ${key.length} characters` : JSON.stringify(key);

function openThisSource(store: string, directory: string) {
  const found = storeCases.find((candidate) => candidate.name === store);
  if (!found) throw new Error(`No store case named ${store}`);
  return found.open(directory);
}

/** A process on the release that holds `key` until it is told to release it, and reports its fencing token. */
const releaseHolder = (store: string, directory: string, key: string) => `
	import { Mutex, ${store} } from ${JSON.stringify(release.url)};
	const mutex = new Mutex(new ${store}(${JSON.stringify(directory)}));
	const done = Promise.withResolvers();
	process.on('message', (message) => {
		if (message === 'release') done.resolve();
	});
	setInterval(() => {}, 1000);
	await mutex.acquire(${JSON.stringify(key)}, async ({ token }) => {
		process.send({ type: 'entered', token: token.value.toString() });
		await done.promise;
	});
	process.send({ type: 'released' });
`;

/** A process on the release that looks at `key` and skips if it is busy, then skips once more when told to. */
const releaseCaller = (store: string, directory: string, key: string) => `
	import { Modes, Mutex, ${store} } from ${JSON.stringify(release.url)};
	const mutex = new Mutex(new ${store}(${JSON.stringify(directory)}));
	const skip = () =>
		mutex.acquire(${JSON.stringify(key)}, async ({ token }) => token.value.toString(), {
			mode: Modes.skipIfBusy(),
		});
	const looked = await mutex.isHeld(${JSON.stringify(key)});
	const whileHeld = await skip();
	process.on('message', async (message) => {
		if (message === 'again') process.send({ type: 'tried again', afterRelease: await skip() });
	});
	process.send({ type: 'tried', looked, whileHeld });
`;

/** This source, imported the way a process imports the release: from its entry point. */
const thisSource = new URL('../index.ts', import.meta.url).href;

/**
 * A process on `version` that waits for `key` behind a dead holder and starts
 * to evict it, then stops at the file step that removes the holder, as if it
 * froze there: it still holds the reclaim lock. Its own file system step is
 * held back, so neither version's code changes. It goes on when told to
 * `resume`, and then holds the key until it is killed.
 */
const pausedEvicter = (
  version: string,
  store: string,
  directory: string,
  key: string,
) => `
	import fsPromises from 'node:fs/promises';
	import { syncBuiltinESMExports } from 'node:module';
	setInterval(() => {}, 1000);
	const resumed = Promise.withResolvers();
	process.on('message', (message) => {
		if (message === 'resume') resumed.resolve();
	});
	const step = ${JSON.stringify(store === 'LockFileStore' ? 'unlink' : 'rename')};
	const real = fsPromises[step];
	let paused = false;
	fsPromises[step] = async (...args) => {
		if (!paused && (String(args.at(-1) ?? '').endsWith('.lock') || String(args[0]).endsWith('.lock'))) {
			paused = true;
			process.send({ type: 'evicting' });
			await resumed.promise;
		}
		return real(...args);
	};
	syncBuiltinESMExports();
	const { Mutex, ${store} } = await import(${JSON.stringify(version)});
	await new Mutex(new ${store}(${JSON.stringify(directory)})).acquire(${JSON.stringify(key)}, async ({ token }) => {
		process.send({ type: 'holding', token: token.value.toString() });
		await new Promise(() => {});
	});
`;

/** The token a message carries, as the decimal string that the other process sent. */
function tokenOf(message: unknown): bigint {
  assert.ok(
    isRecord(message) && typeof message.token === 'string',
    `A token must arrive, got ${JSON.stringify(message)}`,
  );
  return BigInt(message.token);
}

describe('A holder on the latest release, and this source', () => {
  for (const { store, key } of cases) {
    test(
      `${store}, ${label(key)}: this source sees the holder, waits its turn, and gets a newer token`,
      { timeout: 30000 },
      async (t) => {
        // Arrange: a process on the release holds the key. It started first, so a socket store's release process leads.
        await using directory = await scratchDirectory();
        await using holder = startWorker(
          releaseHolder(store, directory.path, key),
          'holder',
        );
        await waitUntil(
          t,
          () => holder.has('entered'),
          () => `The ${release.version} holder must enter.\n${holder.stderr}`,
          newProcessTimeout,
        );
        await using host = openThisSource(store, directory.path);
        const mutex = new Mutex(host.store);
        const skip = () =>
          mutex.acquire(key, async ({ token }) => token.value, {
            mode: Modes.skipIfBusy(),
          });

        // Act
        const looked = await mutex.isHeld(key);
        const whileHeld = await skip();
        holder.child.send('release');
        await waitUntil(
          t,
          () => holder.has('released'),
          () => `The ${release.version} holder must release.\n${holder.stderr}`,
        );
        const afterRelease = await skip();

        // Assert: this source finds the record of the release's holder, and the release frees it for this source.
        assert.deepEqual(
          { looked, whileHeld },
          { looked: true, whileHeld: { acquired: false } },
          `This source must see the ${release.version} holder`,
        );
        assert.ok(afterRelease.acquired, 'This source must get the key next');
        assert.ok(
          afterRelease.value > tokenOf(holder.find('entered')),
          `The token of this source must be newer than the ${release.version} holder's`,
        );
      },
    );
  }
});

describe('A holder on this source, and the latest release', () => {
  for (const { store, key } of cases) {
    test(
      `${store}, ${label(key)}: the release sees the holder, waits its turn, and gets a newer token`,
      { timeout: 30000 },
      async (t) => {
        // Arrange: this source holds the key. It started first, so a socket store's source process leads.
        await using directory = await scratchDirectory();
        await using host = openThisSource(store, directory.path);
        const mutex = new Mutex(host.store);
        const entered = Promise.withResolvers<bigint>();
        const done = Promise.withResolvers<void>();
        const holding = mutex.acquire(key, async ({ token }) => {
          entered.resolve(token.value);
          await done.promise;
        });
        try {
          const holderToken = await entered.promise;

          // Act
          await using caller = startWorker(
            releaseCaller(store, directory.path, key),
            'caller',
          );
          await waitUntil(
            t,
            () => caller.has('tried'),
            () => `The ${release.version} caller must try.\n${caller.stderr}`,
            newProcessTimeout,
          );
          done.resolve();
          await holding;
          caller.child.send('again');
          await waitUntil(
            t,
            () => caller.has('tried again'),
            () =>
              `The ${release.version} caller must try again.\n${caller.stderr}`,
          );

          // Assert: the release finds the record of this source's holder, and this source frees it for the release.
          const tried = caller.find('tried');
          assert.deepEqual(
            { looked: tried?.looked, whileHeld: tried?.whileHeld },
            { looked: true, whileHeld: { acquired: false } },
            `The ${release.version} caller must see this source's holder`,
          );
          const afterRelease = caller.find('tried again')?.afterRelease;
          assert.ok(
            isRecord(afterRelease) && afterRelease.acquired === true,
            `The ${release.version} caller must get the key next, got ${JSON.stringify(afterRelease)}`,
          );
          assert.ok(
            tokenOf({ token: afterRelease.value }) > holderToken,
            `The token of the ${release.version} caller must be newer than this source's`,
          );
        } finally {
          done.resolve();
          await holding;
        }
      },
    );
  }
});

describe('A holder on the latest release that was killed, and this source', () => {
  for (const { store, key } of cases.filter(
    (candidate) =>
      candidate.store !== 'SocketStore' && candidate.key.length < 32,
  )) {
    test(
      `${store}, ${label(key)}: this source finds the holder gone and gets the key`,
      { timeout: 30000 },
      async (t) => {
        // Arrange: a process on the release holds the key and is killed, so its records stay behind.
        await using directory = await scratchDirectory();
        await using holder = startWorker(
          releaseHolder(store, directory.path, key),
          'holder',
        );
        await waitUntil(
          t,
          () => holder.has('entered'),
          () => `The ${release.version} holder must enter.\n${holder.stderr}`,
          newProcessTimeout,
        );
        holder.child.kill('SIGKILL');
        await holder.closed;
        await using host = openThisSource(store, directory.path);
        const mutex = new Mutex(host.store);

        // Act
        const looked = await mutex.isHeld(key);
        const next = await mutex.acquire(
          key,
          async ({ token }) => token.value,
          {
            mode: Modes.skipIfBusy(),
          },
        );

        // Assert: this source reads the presence of the release's holder, finds it gone, and removes its records.
        assert.equal(
          looked,
          false,
          `The killed ${release.version} holder must read as gone`,
        );
        assert.ok(next.acquired, 'This source must get the key');
        assert.ok(
          next.value > tokenOf(holder.find('entered')),
          `The token of this source must be newer than the killed ${release.version} holder's`,
        );
      },
    );
  }
});

describe('Two evicters of one dead holder, one on the latest release and one on this source', () => {
  for (const { store, key } of cases.filter(
    (candidate) =>
      (candidate.store === 'LockFileStore' ||
        candidate.store === 'TicketQueueFileStore') &&
      candidate.key.length < 32,
  )) {
    test(
      `${store}, ${label(key)}: while the release evicts the dead holder, this source waits its turn, and the release then holds the key alone`,
      { timeout: 30000 },
      async (t) => {
        // Arrange: a holder on the release is killed, and an evicter on the release stops inside its eviction.
        await using directory = await scratchDirectory();
        await using holder = startWorker(
          releaseHolder(store, directory.path, key),
          'holder',
        );
        await waitUntil(
          t,
          () => holder.has('entered'),
          () => `The ${release.version} holder must enter.\n${holder.stderr}`,
          newProcessTimeout,
        );
        holder.child.kill('SIGKILL');
        await holder.closed;
        await using evicter = startWorker(
          pausedEvicter(release.url, store, directory.path, key),
          'evicter',
        );
        await waitUntil(
          t,
          () => evicter.has('evicting'),
          () =>
            `The ${release.version} evicter must start to evict.\n${evicter.stderr}`,
          newProcessTimeout,
        );
        await using host = openThisSource(store, directory.path);
        const mutex = new Mutex(host.store);
        const tryOnce = () =>
          mutex.acquire(key, async ({ token }) => token.value, {
            mode: Modes.skipIfBusy(),
          });

        // Act
        const whileEvicting = await tryOnce();
        evicter.child.send('resume');
        await waitUntil(
          t,
          () => evicter.has('holding'),
          () =>
            `The ${release.version} evicter must finish and take the key.\n${evicter.stderr}`,
          newProcessTimeout,
        );
        const afterEviction = await tryOnce();

        // Assert: both versions lock one reclaim file, so they evict in turn, and this source reads
        // the holder that the release evicter became as present instead of evicting it.
        assert.equal(
          whileEvicting.acquired,
          false,
          `This source must not evict while the ${release.version} evicter holds the reclaim lock`,
        );
        assert.equal(
          afterEviction.acquired,
          false,
          `This source must see the ${release.version} evicter hold the key once it finished, and not evict it`,
        );
      },
    );

    test(
      `${store}, ${label(key)}: when the release evicter dies inside its eviction, this source evicts the dead holder and gets the key`,
      { timeout: 30000 },
      async (t) => {
        // Arrange: a holder on the release is killed, and an evicter on the release stops inside its eviction.
        await using directory = await scratchDirectory();
        await using holder = startWorker(
          releaseHolder(store, directory.path, key),
          'holder',
        );
        await waitUntil(
          t,
          () => holder.has('entered'),
          () => `The ${release.version} holder must enter.\n${holder.stderr}`,
          newProcessTimeout,
        );
        holder.child.kill('SIGKILL');
        await holder.closed;
        await using evicter = startWorker(
          pausedEvicter(release.url, store, directory.path, key),
          'evicter',
        );
        await waitUntil(
          t,
          () => evicter.has('evicting'),
          () =>
            `The ${release.version} evicter must start to evict.\n${evicter.stderr}`,
          newProcessTimeout,
        );
        await using host = openThisSource(store, directory.path);
        const mutex = new Mutex(host.store);

        // Act: the evicter dies, so the kernel frees its reclaim lock.
        evicter.child.kill('SIGKILL');
        await evicter.closed;
        const next = await mutex.acquire(
          key,
          async ({ token }) => token.value,
          { mode: Modes.skipIfBusy() },
        );

        // Assert
        assert.ok(
          next.acquired,
          `This source must evict the dead holder once the ${release.version} evicter is gone`,
        );
      },
    );

    test(
      `${store}, ${label(key)}: while this source evicts the dead holder, a waiter on the release waits its turn`,
      { timeout: 30000 },
      async (t) => {
        // Arrange: a holder on the release is killed, and an evicter on this source stops inside its eviction.
        await using directory = await scratchDirectory();
        await using holder = startWorker(
          releaseHolder(store, directory.path, key),
          'holder',
        );
        await waitUntil(
          t,
          () => holder.has('entered'),
          () => `The ${release.version} holder must enter.\n${holder.stderr}`,
          newProcessTimeout,
        );
        holder.child.kill('SIGKILL');
        await holder.closed;
        await using evicter = startWorker(
          pausedEvicter(thisSource, store, directory.path, key),
          'evicter',
        );
        await waitUntil(
          t,
          () => evicter.has('evicting'),
          () => `This source's evicter must start to evict.\n${evicter.stderr}`,
          newProcessTimeout,
        );

        // Act: a waiter on the release tries the key once.
        await using caller = startWorker(
          releaseCaller(store, directory.path, key),
          'caller',
        );
        await waitUntil(
          t,
          () => caller.has('tried'),
          () => `The ${release.version} waiter must try.\n${caller.stderr}`,
          newProcessTimeout,
        );
        // A waiter that evicted would leave the evicter's live ticket first, and a held key.
        await using host = openThisSource(store, directory.path);
        const heldAfterTry = await new Mutex(host.store).isHeld(key);

        // Act: this source's evicter dies, so the kernel frees its reclaim lock, and the waiter tries again.
        evicter.child.kill('SIGKILL');
        await evicter.closed;
        caller.child.send('again');
        await waitUntil(
          t,
          () => caller.has('tried again'),
          () =>
            `The ${release.version} waiter must try again.\n${caller.stderr}`,
          newProcessTimeout,
        );

        // Assert: the waiter evicts once the lock is free, so its first "busy" came from the reclaim lock.
        const tried = caller.find('tried');
        const again = caller.find('tried again');
        assert.ok(
          isRecord(tried) &&
            isRecord(tried.whileHeld) &&
            isRecord(again) &&
            isRecord(again.afterRelease),
          `The ${release.version} waiter must report both tries, got ${JSON.stringify([tried, again])}`,
        );
        assert.equal(
          tried.whileHeld.acquired,
          false,
          `A waiter on ${release.version} must not take the key while this source's evicter holds the reclaim lock`,
        );
        assert.equal(
          heldAfterTry,
          false,
          `A waiter on ${release.version} must leave the dead holder in place while this source's evicter holds the reclaim lock`,
        );
        assert.equal(
          again.afterRelease.acquired,
          true,
          `A waiter on ${release.version} must evict the dead holder once this source's evicter is gone`,
        );
      },
    );

    test(
      `${store}, ${label(key)}: when this source's evicter finishes and holds the key, a waiter on the release leaves it alone`,
      { timeout: 30000 },
      async (t) => {
        // Arrange: a holder on the release is killed, and an evicter on this source stops inside its eviction.
        await using directory = await scratchDirectory();
        await using holder = startWorker(
          releaseHolder(store, directory.path, key),
          'holder',
        );
        await waitUntil(
          t,
          () => holder.has('entered'),
          () => `The ${release.version} holder must enter.\n${holder.stderr}`,
          newProcessTimeout,
        );
        holder.child.kill('SIGKILL');
        await holder.closed;
        await using evicter = startWorker(
          pausedEvicter(thisSource, store, directory.path, key),
          'evicter',
        );
        await waitUntil(
          t,
          () => evicter.has('evicting'),
          () => `This source's evicter must start to evict.\n${evicter.stderr}`,
          newProcessTimeout,
        );
        await using caller = startWorker(
          releaseCaller(store, directory.path, key),
          'caller',
        );
        await waitUntil(
          t,
          () => caller.has('tried'),
          () => `The ${release.version} waiter must try.\n${caller.stderr}`,
          newProcessTimeout,
        );

        // Act: this source's evicter finishes and takes the key, and the waiter on the release tries again.
        evicter.child.send('resume');
        await waitUntil(
          t,
          () => evicter.has('holding'),
          () =>
            `This source's evicter must finish and take the key.\n${evicter.stderr}`,
          newProcessTimeout,
        );
        caller.child.send('again');
        await waitUntil(
          t,
          () => caller.has('tried again'),
          () =>
            `The ${release.version} waiter must try again.\n${caller.stderr}`,
          newProcessTimeout,
        );

        // Assert: the release reads the holder that this source's evicter became as present.
        const again = caller.find('tried again');
        assert.ok(
          isRecord(again) && isRecord(again.afterRelease),
          `The ${release.version} waiter must report its second try, got ${JSON.stringify(again)}`,
        );
        assert.equal(
          again.afterRelease.acquired,
          false,
          `A waiter on ${release.version} must see this source's evicter hold the key once it finished, and not evict it`,
        );
      },
    );
  }
});
