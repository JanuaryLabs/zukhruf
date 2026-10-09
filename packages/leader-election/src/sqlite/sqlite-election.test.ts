import assert from 'node:assert/strict';
// The default export is the module object itself, which mock.method can patch;
// syncBuiltinESMExports then copies the patch to the named exports.
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, sep } from 'node:path';
import { describe, mock, test } from 'node:test';

import { NetworkDirectoryError as FsNetworkDirectoryError } from '@zukhruf/fs';

import { NetworkDirectoryError, SqliteElection } from '../index.ts';
import { scratchDirectory } from '../testing/scratch-directory.ts';
import { newProcessTimeout, waitUntil } from '../testing/wait-until.ts';
import { startWorker } from '../testing/worker-process.ts';

const indexUrl = new URL('../index.ts', import.meta.url);

/** An election in `directory` with the file names these tests use. */
const electionIn = (directory: string) =>
  new SqliteElection({
    directory,
    claimFile: 'term.lock',
    epochFile: 'term.epoch',
  });

/** A process that campaigns once, reports the outcome, and keeps any term until killed. */
const candidateSource = (directory: string, timeout: number) => `
	import { SqliteElection } from ${JSON.stringify(indexUrl.href)};
	setInterval(() => {}, 1000);
	const term = await new SqliteElection({
		directory: ${JSON.stringify(directory)},
		claimFile: 'term.lock',
		epochFile: 'term.epoch',
	}).campaign({ timeout: ${timeout} });
	process.send(term ? { type: 'leader', epoch: term.epoch.toString() } : { type: 'follower' });
`;

const onLinux = {
  skip:
    process.platform === 'linux'
      ? false
      : 'Only Linux statfs reports a stable file system type',
  timeout: 10_000,
};

describe('A SQLite election across processes', () => {
  test(
    'only one of several processes campaigning at the same time becomes leader',
    { timeout: 15_000 },
    async (t) => {
      // Arrange
      await using directory = await scratchDirectory();

      // Act: four processes campaign at the same time and keep whatever they win.
      await using candidates = new AsyncDisposableStack();
      const workers = ['a', 'b', 'c', 'd'].map((name) =>
        candidates.use(startWorker(candidateSource(directory.path, 300), name)),
      );
      await waitUntil(
        t,
        () =>
          workers.every(
            (worker) => worker.has('leader') || worker.has('follower'),
          ),
        () =>
          `Every candidate must report its outcome.\n${workers.map((worker) => worker.stderr).join('')}`,
        newProcessTimeout,
      );

      // Assert
      assert.equal(
        workers.filter((worker) => worker.has('leader')).length,
        1,
        'Exactly one candidate of the same time may win the election',
      );
    },
  );

  test(
    'when the leader dies, another candidate takes over with a higher epoch',
    { timeout: 15_000 },
    async (t) => {
      // Arrange: a leader in another process.
      await using directory = await scratchDirectory();
      const election = electionIn(directory.path);
      await using leader = startWorker(
        candidateSource(directory.path, 1000),
        'leader',
      );
      await waitUntil(
        t,
        () => leader.has('leader'),
        () => `The first candidate must lead.\n${leader.stderr}`,
        newProcessTimeout,
      );
      const epoch = leader.find('leader')?.epoch;
      assert.ok(typeof epoch === 'string', 'The leader must report its epoch');
      assert.equal(
        await election.campaign({ timeout: 100 }),
        undefined,
        'Nobody else may lead while the leader lives',
      );

      // Act: the leader dies without resigning.
      leader.child.kill('SIGKILL');
      await leader.closed;
      await using successor = await election.campaign({ timeout: 2000 });

      // Assert
      assert.ok(
        successor,
        'A candidate must take over once the leader is gone',
      );
      assert.ok(
        successor.epoch > BigInt(epoch),
        `The successor's epoch (${successor.epoch}) must be higher than the dead leader's (${epoch})`,
      );
    },
  );

  test(
    'a leader that resigns hands leadership to the next campaign',
    { timeout: 10_000 },
    async () => {
      // Arrange
      await using directory = await scratchDirectory();
      const election = electionIn(directory.path);
      const first = await election.campaign();
      assert.ok(first, 'The first campaign in an empty directory must win');
      assert.equal(
        await election.campaign(),
        undefined,
        'A second leader must not win while the first leads',
      );

      // Act
      await first.resign();
      await using second = await election.campaign();

      // Assert
      assert.ok(second, 'The next campaign must win after the leader resigns');
      assert.ok(
        second.epoch > first.epoch,
        'Each term must carry a higher epoch than the last',
      );
    },
  );

  test(
    'a campaign that is losing keeps its process responsive',
    { timeout: 10_000 },
    async () => {
      // Arrange: someone else leads for the whole campaign.
      await using directory = await scratchDirectory();
      const election = electionIn(directory.path);
      await using _leader = await election.campaign();
      let ticks = 0;
      const timer = setInterval(() => ticks++, 5);

      try {
        // Act: campaign for 300 ms against the sitting leader.
        const outcome = await election.campaign({ timeout: 300 });

        // Assert: timers kept firing, so waiting never blocked the event loop.
        assert.equal(outcome, undefined);
        // A blocked event loop gives 0 or 1 ticks; Windows timers fire about every 15.6 ms, so expect few.
        assert.ok(
          ticks >= 5,
          `Only ${ticks} timer ticks ran during a 300 ms campaign`,
        );
      } finally {
        clearInterval(timer);
      }
    },
  );
});

describe('The files of a SQLite election', () => {
  test(
    'an election claims the file it is given, and records each epoch as decimal text in the file it is given',
    { timeout: 10_000 },
    async () => {
      // Arrange: a leader holds one claim file. The names are ones no backend would hard-code.
      await using directory = await scratchDirectory();
      const electionOn = (claimFile: string, epochFile: string) =>
        new SqliteElection({ directory: directory.path, claimFile, epochFile });
      await using _leader = await electionOn('seat-a.db', 'count-a').campaign();

      // Act
      const onHeldFile = await electionOn('seat-a.db', 'count-a').campaign();
      await using onOtherFile = await electionOn(
        'seat-b.db',
        'count-b',
      ).campaign();
      // Eleven terms, so the epoch has two digits and decimal differs from hex.
      const counted = electionOn('seat-c.db', 'count-c');
      for (let terms = 0; terms < 11; terms++) {
        await using term = await counted.campaign();
        assert.ok(term, 'Each campaign on a free claim must win');
      }

      // Assert
      assert.equal(onHeldFile, undefined, 'The election ignored a held claim');
      assert.ok(onOtherFile, 'Another claim file must be a claim of its own');
      assert.equal(
        await fsPromises.readFile(join(directory.path, 'count-c'), 'utf8'),
        '11',
      );
    },
  );

  test(
    'a won term is on disk before the campaign resolves, so a power loss cannot repeat its epoch',
    {
      skip:
        process.platform === 'win32'
          ? 'Windows never syncs a directory'
          : false,
      timeout: 10_000,
    },
    async () => {
      // Arrange
      await using directory = await scratchDirectory();
      const election = electionIn(directory.path);
      using disk = recordDiskWrites();

      // Act
      await using _term = await election.campaign();

      // Assert: after the epoch file is replaced, its directory reaches the disk too.
      const replacement = disk.events.findIndex(
        (event) =>
          event.op === 'rename' &&
          event.to === join(directory.path, 'term.epoch'),
      );
      assert.ok(replacement >= 0, 'The epoch must be replaced in one step');
      assert.ok(
        disk.events
          .slice(replacement + 1)
          .some(
            (event) => event.op === 'sync' && event.path === directory.path,
          ),
        'The directory that holds the new epoch must reach the disk before the term starts',
      );
    },
  );
});

describe('A SQLite election in a directory on a network file system', () => {
  test(
    'an election refuses the directory with the one NetworkDirectoryError class of @zukhruf/fs',
    onLinux,
    async () => {
      // Arrange
      await using directory = await scratchDirectory();
      using _mount = mountAs(directory.path, 0x6969n);

      // Act
      const campaigning = electionIn(directory.path).campaign();

      // Assert: the class this package exports is the one each package re-exports.
      await assert.rejects(campaigning, NetworkDirectoryError);
      assert.equal(NetworkDirectoryError, FsNetworkDirectoryError);
    },
  );

  test(
    'an election does not create a directory that it refuses',
    onLinux,
    async () => {
      // Arrange
      await using directory = await scratchDirectory();
      const notYet = join(directory.path, 'not', 'yet');
      using _mount = mountAs(directory.path, 0x6969n);

      // Act
      const campaigning = electionIn(notYet).campaign();

      // Assert
      await assert.rejects(campaigning, NetworkDirectoryError);
      assert.deepEqual(await fsPromises.readdir(directory.path), []);
    },
  );
});

/** Whether `path` is `directory` itself or lies inside it. */
const within = (directory: string, path: string) =>
  path === directory || path.startsWith(directory + sep);

/**
 * Makes statfs report `type` for `directory` and everything inside it, as a
 * mount of that file system would. Every other path gets the real answer.
 */
function mountAs(directory: string, type: bigint) {
  const statfs = fsPromises.statfs;
  mock.method(
    fsPromises,
    'statfs',
    async (...args: Parameters<typeof fsPromises.statfs>) => {
      const stats = await statfs(...args);
      return within(directory, String(args[0]))
        ? Object.assign(stats, { type })
        : stats;
    },
  );
  syncBuiltinESMExports();
  return {
    [Symbol.dispose]() {
      mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}

type DiskEvent =
  | { op: 'write' | 'sync'; path: string }
  | { op: 'rename'; from: string; to: string };

/**
 * Records what this process asks the operating system to write and make
 * durable, by patching node:fs/promises `open` (and each handle's `writeFile`
 * and `sync`) and `rename`. Every call still reaches the real disk.
 */
function recordDiskWrites() {
  const events: DiskEvent[] = [];
  const open = fsPromises.open;
  const rename = fsPromises.rename;
  mock.method(
    fsPromises,
    'open',
    async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await open(...args);
      const path = String(args[0]);
      const writeFile = handle.writeFile.bind(handle);
      const sync = handle.sync.bind(handle);
      handle.writeFile = async (...data: Parameters<typeof writeFile>) => {
        events.push({ op: 'write', path });
        return writeFile(...data);
      };
      handle.sync = async () => {
        events.push({ op: 'sync', path });
        return sync();
      };
      return handle;
    },
  );
  mock.method(fsPromises, 'rename', async (from: string, to: string) => {
    events.push({ op: 'rename', from, to });
    return rename(from, to);
  });
  syncBuiltinESMExports();
  return {
    events,
    [Symbol.dispose]() {
      mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}
