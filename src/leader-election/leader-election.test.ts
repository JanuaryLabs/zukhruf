import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
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
				() => workers.every((worker) => worker.has('leader') || worker.has('follower')),
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
			await using leader = startWorker(candidateSource(directory.path, 1000), 'leader');
			await waitUntil(t, () => leader.has('leader'), `The first candidate must lead.\n${leader.stderr}`, 5000);
			const firstEpoch = BigInt(leader.find('leader')?.epoch as string);
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
			assert.ok(successor, 'A campaigner must take over once the leader is gone');
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
		assert.equal(await election.campaign(), undefined, 'A second leader must not win while the first leads');

		// Act
		await first.resign();
		await using second = await election.campaign();

		// Assert
		assert.ok(second, 'The next campaign must win after the leader resigns');
		assert.ok(second.epoch > first.epoch, 'Each term must carry a higher epoch than the last');
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
			assert.ok(ticks >= 5, `Only ${ticks} timer ticks ran during a 300ms campaign`);
		} finally {
			clearInterval(timer);
		}
	});
});
