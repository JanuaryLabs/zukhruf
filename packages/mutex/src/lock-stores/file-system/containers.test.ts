import assert from 'node:assert/strict';
import { type TestContext, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  type Container,
  Docker,
  type DockerVolume,
  TestRun,
  skipWithoutDocker,
} from '@zukhruf/testing/docker';

/**
 * Containers are platform setup that no operation of the stores exposes. Two
 * containers on one machine share its kernel and a volume, but each has its own
 * hostname and its own PID namespace. A test never pulls the image.
 */
const image = 'node:lts-alpine';
const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });
const noDocker =
  (await skipWithoutDocker(docker, process.env)) ||
  ((await docker.command(['image', 'inspect', image]).then(
    () => false,
    () => true,
  )) &&
    `needs the ${image} image; run \`docker pull ${image}\` to include these tests`);

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const mutexInContainer = 'file:///pkg/src/index.ts';

const stores = ['LockFileStore', 'TicketQueueFileStore'] as const;

/** Takes the key and keeps it until its container stops. */
const holderSource = (storeName: string) => `
	import { Mutex, ${storeName} } from ${JSON.stringify(mutexInContainer)};
	setInterval(() => {}, 1000);
	await new Mutex(new ${storeName}('/locks', { pollInterval: 10 })).acquire('product:42', async (lease) => {
		console.log(JSON.stringify({ type: 'holding', pid: process.pid, token: String(lease.token) }));
		await new Promise(() => {});
	});
`;

/** Asks for the key once, gives up after a second, and prints what it got. */
const waiterSource = (storeName: string) => `
	import { Modes, Mutex, ${storeName} } from ${JSON.stringify(mutexInContainer)};
	const result = await new Mutex(new ${storeName}('/locks', { pollInterval: 10 })).acquire(
		'product:42',
		async (lease) => String(lease.token),
		{ mode: Modes.skipIfBusy({ waitAtMost: 1000 }) },
	);
	console.log(JSON.stringify(result));
`;

interface ContainerOptions {
  /** The lock directory that the containers of one test share. */
  volume: DockerVolume;
  hostname?: string;
  /** Passed to the command as `$SOURCE`, so a shell can start it. */
  source?: string;
}

/** The image, the shared lock directory and the package, for one container. */
const placement = ({ volume, hostname, source }: ContainerOptions) => ({
  image,
  ...(hostname ? { hostname } : {}),
  ...(source ? { env: { SOURCE: source } } : {}),
  mounts: [
    { source: volume.name, target: '/locks' },
    { source: packageRoot, target: '/pkg', readOnly: true },
  ],
});

const startContainer = (options: ContainerOptions, ...command: string[]) =>
  docker.start({ ...placement(options), command });

/** Waits until the holder in `container` prints that it holds the key. */
function holdingIn(
  t: TestContext,
  container: Container,
): Promise<{ pid: number; token: string }> {
  return t.waitFor(
    async () => {
      const line = (await container.logs())
        .split('\n')
        .find((candidate) => candidate.includes('"holding"'));
      assert.ok(
        line,
        `The holder in ${container.containerId} must take the key`,
      );
      return JSON.parse(line);
    },
    { interval: 100, timeout: 20000 },
  );
}

type Grant = { acquired: false } | { acquired: true; value: string };

/** Runs a waiter as the main process (PID 1) of a new container. */
async function waiterIn(
  options: ContainerOptions,
  storeName: string,
): Promise<Grant> {
  const output = await docker.run({
    ...placement(options),
    command: ['node', '--input-type=module', '--eval', waiterSource(storeName)],
  });
  return JSON.parse(output.split('\n').at(-1)!);
}

/** The waiter got the key, with a newer token than the holder it replaced. */
function assertTakenOver(
  waiter: Grant,
  held: { token: string },
  message: string,
) {
  assert.ok(waiter.acquired, message);
  assert.ok(
    BigInt(waiter.value) > BigInt(held.token),
    `The waiter's token ${waiter.value} must be newer than the holder's ${held.token}`,
  );
}

/** Every lock file in the volume with its owner record, for failure messages. */
const lockFiles = (volume: DockerVolume) =>
  docker.run({
    image,
    mounts: [{ source: volume.name, target: '/locks' }],
    command: [
      'sh',
      '-c',
      'for f in /locks/*.lock; do echo "$f: $(cat "$f")"; done',
    ],
  });

for (const storeName of stores) {
  describe(`${storeName} shared by containers on one machine`, () => {
    test(
      'a waiter never takes the key of a holder that is alive in another container with the same hostname',
      { skip: noDocker },
      async (t) => {
        // Arrange: the holder starts after 300 other processes, so its PID
        // number does not exist in a fresh container, where the waiter runs.
        await using volume = await docker.volume();
        await using holder = await startContainer(
          { volume, hostname: 'app', source: holderSource(storeName) },
          'sh',
          '-c',
          'i=0; while [ $i -lt 300 ]; do /bin/true; i=$((i+1)); done; node --input-type=module --eval "$SOURCE"; true',
        );
        const held = await holdingIn(t, holder);
        const record = await lockFiles(volume);

        // Act: a second container with the same hostname asks for the key.
        const waiter = await waiterIn({ volume, hostname: 'app' }, storeName);

        // Assert: the holder is still inside its task, so the key is busy.
        assert.deepEqual(
          waiter,
          { acquired: false },
          `Two holders: PID ${held.pid} holds token ${held.token} in its own container, and the waiter took the key too. The lock file said ${record}`,
        );
      },
    );

    test(
      'a waiter gets the key of a holder that was killed in another container with its own hostname',
      { skip: noDocker },
      async (t) => {
        // Arrange: each container keeps the hostname Docker gives it.
        await using volume = await docker.volume();
        await using holder = await startContainer(
          { volume },
          'node',
          '--input-type=module',
          '--eval',
          holderSource(storeName),
        );
        const held = await holdingIn(t, holder);
        await holder.kill();
        const record = await lockFiles(volume);

        // Act
        const waiter = await waiterIn({ volume }, storeName);

        // Assert: nothing is left that could still use the key.
        assertTakenOver(
          waiter,
          held,
          `The holder's container is gone, yet its key stays held. The lock file says ${record}`,
        );
      },
    );

    test(
      'a waiter gets the key of a holder that was killed in another container with the same hostname',
      { skip: noDocker },
      async (t) => {
        // Arrange: holder and waiter are each their container's main process, PID 1.
        await using volume = await docker.volume();
        await using holder = await startContainer(
          { volume, hostname: 'app' },
          'node',
          '--input-type=module',
          '--eval',
          holderSource(storeName),
        );
        const held = await holdingIn(t, holder);
        await holder.kill();
        const record = await lockFiles(volume);

        // Act
        const waiter = await waiterIn({ volume, hostname: 'app' }, storeName);

        // Assert
        assertTakenOver(
          waiter,
          held,
          `The holder's container is gone, yet its key stays held. The lock file says ${record}`,
        );
      },
    );

    test(
      'a waiter gets the key of a holder that was killed in its own container',
      { skip: noDocker },
      async (t) => {
        // Arrange: the container's shell starts the holder and reaps it when it
        // dies, so a dead holder leaves no zombie that still answers kill(pid, 0).
        await using volume = await docker.volume();
        await using box = await startContainer(
          { volume, hostname: 'app', source: holderSource(storeName) },
          'sh',
          '-c',
          'node --input-type=module --eval "$SOURCE" & wait; sleep infinity',
        );
        const held = await holdingIn(t, box);
        await box.exec(['kill', '-9', String(held.pid)]);

        // Act: the waiter runs in the same container, so it sees the holder's PID namespace.
        const { stdout: output } = await box.exec([
          'node',
          '--input-type=module',
          '--eval',
          waiterSource(storeName),
        ]);

        // Assert: one PID namespace is the case the stores are built for.
        assertTakenOver(
          JSON.parse(output.split('\n').at(-1)!),
          held,
          'A dead holder in the waiter’s own PID namespace must be evicted',
        );
      },
    );
  });
}
