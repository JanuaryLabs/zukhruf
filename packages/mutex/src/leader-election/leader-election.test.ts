import assert from 'node:assert/strict';
// The default export is the module object itself, which mock.method can patch;
// syncBuiltinESMExports then copies the patch to the named exports.
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
import { describe, mock, test } from 'node:test';

import { scratchDirectory } from '../testing/scratch-directory.ts';
import { waitUntil } from '../testing/wait-until.ts';
import { startWorker } from '../testing/worker-process.ts';
import { LeaderElection } from './leader-election.ts';

const leaderElectionUrl = new URL('./leader-election.ts', import.meta.url);

/** A process that campaigns once, reports the outcome, and keeps any term until killed. */
const candidateSource = (directory: string, timeout: number) => `
	import { LeaderElection } from ${JSON.stringify(leaderElectionUrl.href)};
	setInterval(() => {}, 1000);
	const leadership = await new LeaderElection(${JSON.stringify(directory)}).campaign({ timeout: ${timeout} });
	process.send(
		leadership
			? { type: 'leader', epoch: leadership.epoch.toString() }
			: { type: 'follower' },
	);
`;

describe('Leader election', () => {
  test(
    'only one of several processes campaigning at the same time becomes leader',
    { timeout: 10000 },
    async (t) => {
      // Arrange
      await using directory = await scratchDirectory();

      // Act: four processes campaign concurrently and keep whatever they win.
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
        `Every candidate must report its outcome.\n${workers.map((worker) => worker.stderr).join('')}`,
        5000,
      );

      // Assert
      assert.equal(
        workers.filter((worker) => worker.has('leader')).length,
        1,
        'Exactly one concurrent candidate may win the election',
      );
    },
  );

  test(
    'when the leader dies, another campaigner takes over with a higher epoch',
    { timeout: 10000 },
    async (t) => {
      // Arrange: a leader in another process.
      await using directory = await scratchDirectory();
      const election = new LeaderElection(directory.path);
      await using leader = startWorker(
        candidateSource(directory.path, 1000),
        'leader',
      );
      await waitUntil(
        t,
        () => leader.has('leader'),
        `The first candidate must lead.\n${leader.stderr}`,
        5000,
      );
      const epoch = leader.find('leader')?.epoch;
      assert.ok(typeof epoch === 'string', 'The leader must report its epoch');
      const firstEpoch = BigInt(epoch);
      assert.equal(
        await election.campaign({ timeout: 100 }),
        undefined,
        'Nobody else may lead while the leader is alive',
      );

      // Act: the leader dies without resigning.
      leader.child.kill('SIGKILL');
      await leader.closed;
      await using successor = await election.campaign({ timeout: 2000 });

      // Assert
      assert.ok(
        successor,
        'A campaigner must take over once the leader is gone',
      );
      assert.ok(
        successor.epoch > firstEpoch,
        `The successor's epoch (${successor.epoch}) must be higher than the dead leader's (${firstEpoch})`,
      );
    },
  );

  test('a leader that resigns hands leadership to the next campaigner', async () => {
    // Arrange
    await using directory = await scratchDirectory();
    const election = new LeaderElection(directory.path);
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
  });

  test('a campaign that is losing keeps its process responsive', async () => {
    // Arrange: someone else leads for the whole campaign.
    await using directory = await scratchDirectory();
    const election = new LeaderElection(directory.path);
    await using _leader = await election.campaign();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);

    try {
      // Act: campaign for 300ms against the sitting leader.
      const outcome = await election.campaign({ timeout: 300 });

      // Assert: timers kept firing, so waiting never blocked the event loop.
      assert.equal(outcome, undefined);
      // A blocked event loop gives 0 or 1 ticks; Windows timers fire about every 15.6 ms, so expect few.
      assert.ok(
        ticks >= 5,
        `Only ${ticks} timer ticks ran during a 300ms campaign`,
      );
    } finally {
      clearInterval(timer);
    }
  });
});

describe('Leader election durability', () => {
  test('a won term writes its epoch to disk before it replaces the previous one', async () => {
    // Arrange
    await using directory = await scratchDirectory();
    const election = new LeaderElection(directory.path);
    using disk = recordDiskWrites();

    // Act
    await using leadership = await election.campaign();

    // Assert: content first, then its sync, then the one-step replacement, which holds the term's epoch.
    assert.ok(leadership, 'The first campaign in an empty directory must win');
    const replacement = disk.replacementIn(directory.path);
    const before = disk.events.slice(0, replacement.index);
    const written = before.findIndex(
      (event) => event.op === 'write' && event.path === replacement.from,
    );
    const synced = before.findIndex(
      (event) => event.op === 'sync' && event.path === replacement.from,
    );
    assert.ok(written >= 0, 'The new epoch must be written');
    assert.ok(
      synced > written,
      'The new epoch must reach the disk after it is written and before it replaces the old one',
    );
    assert.equal(
      await fsPromises.readFile(replacement.to, 'utf8'),
      leadership.epoch.toString(),
    );
  });

  test(
    'a won term is on disk before the campaign returns, so a power loss cannot repeat its epoch',
    {
      skip:
        process.platform === 'win32'
          ? 'Windows never syncs a directory'
          : false,
    },
    async () => {
      // Arrange
      await using directory = await scratchDirectory();
      const election = new LeaderElection(directory.path);
      using disk = recordDiskWrites();

      // Act
      await using _leadership = await election.campaign();

      // Assert
      const replacement = disk.replacementIn(directory.path);
      assert.ok(
        disk.events
          .slice(replacement.index + 1)
          .some(
            (event) => event.op === 'sync' && event.path === directory.path,
          ),
        'The directory that holds the new epoch must reach the disk before the term starts',
      );
    },
  );
});

type DiskEvent =
  | { op: 'write' | 'sync'; path: string }
  | { op: 'rename'; from: string; to: string };

/**
 * Records what this process asks the operating system to write and make
 * durable, by patching node:fs/promises `open` (and each handle's `writeFile`
 * and `sync`) and `rename`. It pins those Node APIs: an equivalent call such
 * as `fs.fsync(fd)` would not be seen. Every call still reaches the real disk.
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
    /** The rename that put a new file into `directory`, and where it sits among the events. */
    replacementIn(directory: string) {
      const index = events.findIndex(
        (event) => event.op === 'rename' && dirname(event.to) === directory,
      );
      const event = events[index];
      assert.ok(
        event?.op === 'rename',
        'The file must be replaced in one step',
      );
      return { index, from: event.from, to: event.to };
    },
    [Symbol.dispose]() {
      mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}
