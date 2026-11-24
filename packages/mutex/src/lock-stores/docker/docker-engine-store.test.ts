import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { untilAborted } from '@zukhruf/async';
import { Docker } from '@zukhruf/docker';
import { TemporaryFiles } from '@zukhruf/fs';
import { waitFor } from '@zukhruf/testing/async';
import { DockerTestbed } from '@zukhruf/testing/docker';
import { startWorker } from '@zukhruf/testing/process';

import { Mutex } from '../../index.ts';
import { hold } from '../../testing/hold.ts';
import { engineProxy } from '../../testing/subjects/docker-engine.ts';
import { DockerEngineStore, DockerEngineStoreWarning } from './index.ts';

/**
 * The first sixteen tests are the design errors that the probes of
 * DockerEngineStore found. The name of each test says what the wrong design
 * broke. The tests after them are the contract of a lock store.
 */

const image = 'node:lts-alpine';
const heartbeatInterval = 500;
const namespaceLabel = 'zukhruf.mutex.namespace';

/**
 * A client of the local engine, with `image` on it, and a new namespace. The
 * store never pulls its image, so the test pulls it before any store starts.
 * The disposal first ends the client, so that no store of the test creates
 * anything later, and then removes each container and volume with the label
 * of the namespace.
 */
async function engine() {
  const docker = await Docker.connect({
    clock: globalThis,
    environment: process.env,
  });
  if (!(await docker.images.inspect(image))) await docker.images.pull(image);
  const namespace = `zukhruf-mutex-test-${randomUUID()}`;
  const label = { label: [`${namespaceLabel}=${namespace}`] };
  const { Labels: labels } = await new DockerTestbed({
    environment: process.env,
  }).defaults();
  return {
    docker,
    namespace,
    labels,
    store: (client: Docker = docker, claimImage = image) =>
      new DockerEngineStore({
        docker: client,
        image: claimImage,
        namespace,
        heartbeatInterval,
        labels,
        clock: globalThis,
      }),
    [Symbol.asyncDispose]: async () => {
      await docker[Symbol.asyncDispose]();
      await using cleaner = await Docker.connect({
        clock: globalThis,
        environment: process.env,
      });
      for (const { Id } of await cleaner.containers.list({
        all: true,
        filters: label,
      })) {
        await (await cleaner.containers.find(Id))?.remove({ force: true });
      }
      for (const { Name } of await cleaner.volumes.list({ filters: label })) {
        await (await cleaner.volumes.find(Name))?.remove({ force: true });
      }
    },
  };
}

/** Takes the key in its own process, reports its token, and keeps the key until it is killed. */
const holderSource = (namespace: string, key: string) => `
	import { Docker } from ${JSON.stringify(import.meta.resolve('@zukhruf/docker'))};
	import { Mutex } from ${JSON.stringify(new URL('../../index.ts', import.meta.url).href)};
	import { DockerTestbed } from ${JSON.stringify(import.meta.resolve('@zukhruf/testing/docker'))};
	import { DockerEngineStore } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
	setInterval(() => {}, 1000);
	const docker = await Docker.connect({ clock: globalThis, environment: process.env });
	const { Labels: labels } = await new DockerTestbed({ environment: process.env }).defaults();
	const store = new DockerEngineStore({ docker, image: ${JSON.stringify(image)}, namespace: ${JSON.stringify(namespace)}, heartbeatInterval: ${heartbeatInterval}, labels, clock: globalThis });
	await new Mutex(store).acquire(${JSON.stringify(key)}, async (lease) => {
		process.send({ type: 'holding', token: String(lease.token.value) });
		await new Promise(() => {});
	});
`;

test("a killed holder's key goes to the next waiter", async (t) => {
  // Arrange: another process holds the key.
  await using fixture = await engine();
  await using holder = startWorker(
    holderSource(fixture.namespace, 'report:daily'),
    'holder',
  );
  await holder.next('holding', { signal: t.signal });
  const waiting = new Mutex(fixture.store()).acquire(
    'report:daily',
    async (lease) => lease.token.value,
  );

  // Act
  holder.child.kill('SIGKILL');
  const token = await untilAborted(waiting, t.signal);

  // Assert: the end of the attach of a killed holder ended its claim.
  assert.ok(token > BigInt(String(holder.find('holding')?.token)));
});

/** The OpenSSH server of `droppableSshEngine`: a key login as root, with the defaults of sshd for a client that went away. Alpine's sshd_config sets `AllowTcpForwarding no`, which also denies the connect to the engine socket. */
const sshdScript = [
  'apk add --no-cache openssh-server iptables > /dev/null',
  'ssh-keygen -A > /dev/null',
  'mkdir -p /root/.ssh',
  'printf "%s\\n" "$KEY" > /root/.ssh/authorized_keys',
  'exec /usr/sbin/sshd -D -e -o ClientAliveInterval=0 -o TCPKeepAlive=yes -o AllowTcpForwarding=yes -o AllowStreamLocalForwarding=yes -o PermitRootLogin=prohibit-password',
].join(' && ');

/** The first bytes that the server on 127.0.0.1:`port` sends, or nothing when it closes first. */
async function banner(port: number): Promise<string> {
  const socket = connect(port, '127.0.0.1');
  try {
    const [data] = await Promise.race([
      once(socket, 'data'),
      once(socket, 'close').then(() => ['']),
    ]);
    return String(data);
  } finally {
    socket.destroy();
  }
}

/**
 * An SSH engine host whose network a test can cut (#5543): an OpenSSH server
 * in a container of the local engine, which reaches that engine at
 * /var/run/docker.sock. sshd sends no probe of its own (`ClientAliveInterval
 * 0`, its default), and TCP keep-alive waits 2 h. `tcp_retries2=5` in the
 * network namespace of the container ends a connection whose data gets no
 * answer after about 12.6 s, instead of about 15.4 min. Platform setup that
 * no product operation exposes: a holder machine that goes away with no
 * close.
 */
async function droppableSshEngine() {
  await using stack = new AsyncDisposableStack();
  const directory = stack.use(
    await new TemporaryFiles().directory('zukhruf-sshd-'),
  );
  const key = join(directory.path, 'id_ed25519');
  await promisify(execFile)('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-f',
    key,
  ]);
  const service = stack.use(
    await new DockerTestbed({ environment: process.env }).serve(
      {
        Image: 'alpine:latest',
        Entrypoint: ['sh', '-c', sshdScript],
        Env: [`KEY=${(await readFile(`${key}.pub`, 'utf8')).trim()}`],
        HostConfig: {
          CapAdd: ['NET_ADMIN'],
          Sysctls: { 'net.ipv4.tcp_retries2': '5' },
          Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
        },
      },
      {
        internalPort: 22,
        healthy: ({ port }, exited) =>
          waitFor(async () => assert.match(await banner(port), /^SSH-2\.0-/), {
            signal: exited,
            interval: 200,
          }),
      },
    ),
  );
  const hostKey = await service.container.exec({
    Cmd: ['cat', '/etc/ssh/ssh_host_ed25519_key.pub'],
  });
  const knownHosts = join(directory.path, 'known_hosts');
  await writeFile(
    knownHosts,
    `[${service.host}]:${service.port} ${hostKey.stdout.trim()}\n`,
  );
  const owned = stack.move();
  return {
    /** The ssh:// host of the local engine through the server. */
    host: `ssh://root@${service.host}:${service.port}/var/run/docker.sock`,
    /** The flags of `ssh` that log in with the test's key and trust only the server's host key. */
    flags: [
      '-F',
      '/dev/null',
      '-i',
      key,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'IdentityAgent=none',
      '-o',
      `UserKnownHostsFile=${knownHosts}`,
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      'StrictHostKeyChecking=yes',
    ],
    /** Drops each packet of port 22 in the server's network namespace, both ways: no close and no answer reaches either side. */
    async drop() {
      const dropped = await service.container.exec({
        Cmd: [
          'sh',
          '-c',
          'iptables -I INPUT -p tcp --dport 22 -j DROP && iptables -I OUTPUT -p tcp --sport 22 -j DROP',
        ],
      });
      assert.equal(dropped.exitCode, 0, dropped.stderr);
    },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

/** Takes the key in its own process through its own SSH connection to `host`, reports its token, and keeps the key until it is killed. */
const sshHolderSource = (
  namespace: string,
  key: string,
  { host, flags }: { host: string; flags: string[] },
) => `
	import { Docker } from ${JSON.stringify(import.meta.resolve('@zukhruf/docker'))};
	import { Mutex } from ${JSON.stringify(new URL('../../index.ts', import.meta.url).href)};
	import { DockerEngineStore } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
	setInterval(() => {}, 1000);
	const docker = await Docker.connect({ clock: globalThis, environment: { ...process.env, DOCKER_HOST: ${JSON.stringify(host)} }, sshFlags: ${JSON.stringify(flags)} });
	const store = new DockerEngineStore({ docker, image: ${JSON.stringify(image)}, namespace: ${JSON.stringify(namespace)}, heartbeatInterval: ${heartbeatInterval}, clock: globalThis });
	await new Mutex(store).acquire(${JSON.stringify(key)}, async (lease) => {
		process.send({ type: 'holding', token: String(lease.token.value) });
		await new Promise(() => {});
	});
`;

// The wait ends at the time limit of the test target, 300 s, with the start of
// the SSH server and the hold. With a keep-alive byte each 15 s, about 12.6 s of
// retransmissions and the waits of the waiter, it ends in about 30 s; with no
// keep-alive byte, TCP keep-alive of the engine's host waits 2 h.
test("a key whose holder machine reaches the engine over SSH and goes away with no close goes to the next waiter within the keep-alive interval and the retransmission limit of the engine's host", async (t) => {
  // Arrange: another process holds the key through an SSH server whose packets the test can drop.
  await using fixture = await engine();
  await using sshd = await droppableSshEngine();
  await using holder = startWorker(
    sshHolderSource(fixture.namespace, 'report:daily', sshd),
    'holder',
  );
  await holder.next('holding', { signal: t.signal });
  const waiting = new Mutex(fixture.store()).acquire(
    'report:daily',
    async (lease) => lease.token.value,
  );

  // Act: the network of the holder machine goes away, and then the holder, so no close reaches the engine's host.
  await sshd.drop();
  holder.child.kill('SIGKILL');
  const token = await untilAborted(waiting, t.signal);

  // Assert: the engine's host ended the connection of the gone holder, so its claim ended.
  assert.ok(token > BigInt(String(holder.find('holding')?.token)));
});

test('an acquire whose claim image has sh and no cat rejects with the code 127 and the image', async (t) => {
  // Arrange: an image that has sh and no cat.
  await using fixture = await engine();
  if (!(await fixture.docker.images.inspect('busybox:1.37.0'))) {
    await fixture.docker.images.pull('busybox:1.37.0');
  }
  const noCat = `zukhruf-mutex-test-no-cat:${randomUUID()}`;
  await fixture.docker.images.build(
    {
      files: [
        { path: 'Dockerfile', data: 'FROM busybox:1.37.0\nRUN rm /bin/cat\n' },
      ],
    },
    { t: noCat, labels: fixture.labels },
  );
  try {
    // Act
    const acquired = new Mutex(fixture.store(fixture.docker, noCat)).acquire(
      'report:daily',
      async () => {},
    );
    const settled = untilAborted(acquired, t.signal);

    // Assert
    await assert.rejects(settled, {
      message: new RegExp(
        `exited with the code 127: the image ${RegExp.escape(JSON.stringify(noCat))} `,
      ),
    });
  } finally {
    await fixture.docker.images.remove(noCat, { force: true });
  }
});

test('a waiter wakes when the holder releases between the create of the waiter and its wait', async (t) => {
  // Arrange: the waiter reaches the engine through a proxy that holds its requests after its create gets the name conflict.
  await using fixture = await engine();
  await using proxy = await engineProxy(fixture.docker);
  await using waiterClient = await Docker.connect({
    clock: globalThis,
    host: proxy.host,
  });
  const holder = await hold(new Mutex(fixture.store()), 'report:daily');
  const afterConflict = proxy.holdAfterNameConflict();
  const waiting = new Mutex(fixture.store(waiterClient)).acquire(
    'report:daily',
    async (lease) => lease.token.value,
  );
  await afterConflict.reached;

  // Act: the release comes before the waiter starts its wait.
  await holder.release();
  afterConflict.release();
  const token = await untilAborted(waiting, t.signal);

  // Assert: the release before the wait was not lost.
  assert.ok(token > holder.token);
});

test('a key whose caller stopped between the create and the start goes to the next waiter after heartbeatInterval', async (t) => {
  // Arrange: a caller created its claim, and the proxy keeps its start from the engine.
  await using fixture = await engine();
  await using proxy = await engineProxy(fixture.docker);
  await using stoppedClient = await Docker.connect({
    clock: globalThis,
    host: proxy.host,
  });
  const beforeStart = proxy.holdRequestsFrom(
    /^POST \S*\/containers\/[0-9a-f]+\/start /,
  );
  const stopped = new Mutex(fixture.store(stoppedClient)).acquire(
    'report:daily',
    async () => {},
  );
  stopped.catch(() => {});
  await beforeStart.reached;

  // Act
  const started = performance.now();
  const waited = await untilAborted(
    new Mutex(fixture.store()).acquire(
      'report:daily',
      async () => performance.now() - started,
    ),
    t.signal,
  );

  // Assert: the waiter removed the created claim that nobody starts, and not
  // before heartbeatInterval; load on the engine can only make the wait longer.
  assert.ok(
    waited >= heartbeatInterval,
    `The waiter got the key ${waited.toFixed(0)} ms after it asked, before heartbeatInterval`,
  );
});

test('a caller whose claim a waiter removed before the start tries again', async (t) => {
  // Arrange: a slow caller's start is held until a waiter removed its created claim and took the key.
  await using fixture = await engine();
  await using proxy = await engineProxy(fixture.docker);
  await using slowClient = await Docker.connect({
    clock: globalThis,
    host: proxy.host,
  });
  const beforeStart = proxy.holdRequestsFrom(
    /^POST \S*\/containers\/[0-9a-f]+\/start /,
  );
  const slow = new Mutex(fixture.store(slowClient)).acquire(
    'report:daily',
    async (lease) => lease.token.value,
  );
  slow.catch(() => {});
  await beforeStart.reached;
  const waiter = await hold(new Mutex(fixture.store()), 'report:daily');

  // Act: the start of the slow caller arrives after the removal of its claim.
  beforeStart.release();
  await delay(heartbeatInterval);
  await waiter.release();
  const token = await untilAborted(slow, t.signal);

  // Assert: the start that lost to a removal sent the caller back to the create.
  assert.ok(token > waiter.token);
});

/**
 * Takes the key in its own process, reports how its acquire settled, and
 * keeps nothing else alive. `atStart` runs once, with `request` and `report`,
 * when the store makes the request of the start of its first claim, before
 * the request goes out.
 */
const startedCallerSource = (
  namespace: string,
  key: string,
  atStart: string,
) => `
	import { execFileSync } from 'node:child_process';
	import { subscribe } from 'node:diagnostics_channel';
	import { Docker } from ${JSON.stringify(import.meta.resolve('@zukhruf/docker'))};
	import { Mutex } from ${JSON.stringify(new URL('../../index.ts', import.meta.url).href)};
	import { DockerTestbed } from ${JSON.stringify(import.meta.resolve('@zukhruf/testing/docker'))};
	import { DockerEngineStore } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
	const docker = await Docker.connect({ clock: globalThis, environment: process.env });
	const { Labels: labels } = await new DockerTestbed({ environment: process.env }).defaults();
	const report = { started: false };
	subscribe('http.client.request.created', ({ request }) => {
		if (report.started || request.method !== 'POST' || !request.path.endsWith('/start')) return;
		report.started = true;
		${atStart}
	});
	const store = new DockerEngineStore({ docker, image: ${JSON.stringify(image)}, namespace: ${JSON.stringify(namespace)}, heartbeatInterval: ${heartbeatInterval}, labels, clock: globalThis });
	try {
		await new Mutex(store).acquire(${JSON.stringify(key)}, async () => {});
		process.send({ type: 'settled', ...report });
	} catch (error) {
		process.send({ type: 'settled', ...report, error: error.message });
	}
`;

test('a caller whose claim a rival removed before its start takes the key with a new claim, and its process exits by itself', async (t) => {
  // Arrange: the caller's start of its first claim reaches the engine after the removal of that claim, as a waiter removes a claim that stays created.
  await using fixture = await engine();
  await using caller = startWorker(
    startedCallerSource(
      fixture.namespace,
      'report:daily',
      `report.removed = request.path.split('/').at(-2);
		execFileSync('docker', ['rm', report.removed], { env: { ...process.env, ...docker.cliEnvironment } });`,
    ),
    'caller',
  );

  // Act
  const settled = await caller.next('settled', { signal: t.signal });
  // The attach of a claim whose start found no container ends, so the
  // process exits once it released the key.
  await untilAborted(caller.closed, t.signal);

  // Assert
  assert.equal(settled.error, undefined, caller.stderr);
  assert.equal(
    typeof settled.removed,
    'string',
    'The rival must remove the first claim at its start',
  );
  assert.deepEqual(caller.exit, { code: 0, signal: null }, caller.stderr);
});

test('a caller whose start fails before it reaches the engine rejects with that failure, and its process exits by itself', async (t) => {
  // Arrange: the request of the start of the caller's claim fails before the engine gets it, as a dropped connection fails it, so the claim never starts.
  await using fixture = await engine();
  await using caller = startWorker(
    startedCallerSource(
      fixture.namespace,
      'report:daily',
      `request.destroy(new Error('The connection dropped the start.'));`,
    ),
    'caller',
  );

  // Act
  const settled = await caller.next('settled', { signal: t.signal });
  // The attach of a claim whose start failed ends, so the process exits once
  // its acquire rejected.
  await untilAborted(caller.closed, t.signal);

  // Assert
  assert.equal(settled.error, 'The connection dropped the start.');
  assert.deepEqual(caller.exit, { code: 0, signal: null }, caller.stderr);
});

test('a holder that lost its claim during the mint gets no token', async (t) => {
  // Arrange: a holder read the ladder, and the proxy keeps its create of a rung from the engine.
  await using fixture = await engine();
  await using proxy = await engineProxy(fixture.docker);
  await using staleClient = await Docker.connect({
    clock: globalThis,
    host: proxy.host,
  });
  const ran: string[] = [];
  const beforeRung = proxy.holdRequestsFrom(/^POST \S*\/volumes\/create /);
  const stale = new Mutex(fixture.store(staleClient)).acquire(
    'report:daily',
    async (lease) => {
      ran.push(`stale ${lease.token.value}`);
      return lease.token.value;
    },
  );
  stale.catch(() => {});
  await beforeRung.reached;
  const [claim] = await fixture.docker.containers.list({
    all: true,
    filters: { label: [`${namespaceLabel}=${fixture.namespace}`] },
  });
  assert.ok(claim);
  await (
    await fixture.docker.containers.find(claim.Id)
  )?.remove({
    force: true,
  });
  const next = await hold(new Mutex(fixture.store()), 'report:daily');
  ran.push(`next ${next.token}`);

  // Act: the stale holder creates its rung while the next holder holds.
  beforeRung.release();
  await delay(2 * heartbeatInterval);
  const whileNextHolds = [...ran];
  await next.release();
  const token = await untilAborted(stale, t.signal);

  // Assert
  assert.deepEqual(
    whileNextHolds,
    [`next ${next.token}`],
    'A holder whose claim is gone must not run with the token it minted',
  );
  assert.ok(
    token > next.token,
    `The stale caller got ${token} after ${next.token}`,
  );
});

test('the tokens increase after docker container prune', async (t) => {
  // Arrange
  await using fixture = await engine();
  const mutex = new Mutex(fixture.store());
  const first = await mutex.acquire(
    'report:daily',
    async (lease) => lease.token.value,
    { signal: t.signal },
  );

  // Act: an operator prunes the containers of the namespace that do not run.
  await promisify(execFile)(
    'docker',
    [
      'container',
      'prune',
      '--force',
      '--filter',
      `label=${namespaceLabel}=${fixture.namespace}`,
    ],
    { signal: t.signal },
  );
  const second = await mutex.acquire(
    'report:daily',
    async (lease) => lease.token.value,
    { signal: t.signal },
  );

  // Assert
  assert.ok(second > first, `The token went from ${first} to ${second}`);
});

test('the tokens increase after the ladder volumes are removed', async () => {
  // Arrange
  await using fixture = await engine();
  const mutex = new Mutex(fixture.store());
  const first = await mutex.acquire(
    'report:daily',
    async (lease) => lease.token.value,
  );

  // Act: an operator removes the volumes of the namespace, as `docker volume prune -a` does.
  for (const { Name } of await fixture.docker.volumes.list({
    filters: { label: [`${namespaceLabel}=${fixture.namespace}`] },
  })) {
    await (await fixture.docker.volumes.find(Name))?.remove();
  }
  const second = await mutex.acquire(
    'report:daily',
    async (lease) => lease.token.value,
  );

  // Assert
  assert.ok(
    second > first,
    `The token went from ${first} to ${second}, so a stale holder with ${first} can still write`,
  );
});

test('a rung above the engine time still gives a higher token', async () => {
  // Arrange: a rung far above the engine time stands for a clock of the engine that went back.
  // The test makes it, because no operation of the store moves the clock of the engine.
  await using fixture = await engine();
  const mutex = new Mutex(fixture.store());
  await mutex.acquire('report:daily', async () => {});
  const [rung] = await fixture.docker.volumes.list({
    filters: { label: [`${namespaceLabel}=${fixture.namespace}`] },
  });
  assert.ok(rung);
  const high = 2n ** 52n;
  await fixture.docker.volumes.create({
    Name: rung.Name.replace(/\d+$/, String(high)),
    Labels: rung.Labels ?? {},
  });

  // Act
  const token = await mutex.acquire(
    'report:daily',
    async (lease) => lease.token.value,
  );

  // Assert
  assert.equal(token, high + 1n);
});

test('a token is the engine time of the claim in microseconds', async () => {
  // Arrange
  await using fixture = await engine();
  const holder = await hold(new Mutex(fixture.store()), 'report:daily');
  const [claim] = await fixture.docker.containers.list({
    all: true,
    filters: { label: [`${namespaceLabel}=${fixture.namespace}`] },
  });
  assert.ok(claim);

  // Act
  const created = (
    await (await fixture.docker.containers.find(claim.Id))?.inspect()
  )?.Created;
  await holder.release();

  // Assert: the engine writes RFC 3339 in UTC with up to nine digits of a fraction.
  const [, seconds, fraction = ''] =
    /^(.+?)(?:\.(\d+))?Z$/.exec(created ?? '') ?? [];
  assert.ok(seconds, `The claim has the Created time ${created}`);
  assert.equal(
    holder.token,
    BigInt(Date.parse(`${seconds}Z`)) * 1000n +
      BigInt(fraction.padEnd(6, '0').slice(0, 6)),
    `The token ${holder.token} is not the Created time ${created} in microseconds`,
  );
});

test('a waiter gets the key when the released claim stays dead after a failed removal', async (t) => {
  // Arrange: a released claim whose removal failed stays on the engine and does not run.
  // The test makes it, because no operation of the store makes the removal of the engine fail.
  await using fixture = await engine();
  const labelled = { label: [`${namespaceLabel}=${fixture.namespace}`] };
  const holder = await hold(new Mutex(fixture.store()), 'report:daily');
  const [claim] = await fixture.docker.containers.list({
    all: true,
    filters: labelled,
  });
  const name = claim?.Names?.[0]?.slice(1);
  const labels = claim?.Labels;
  assert.ok(name && labels);
  await holder.release();
  const ended = await fixture.docker.containers.create(
    {
      Image: image,
      Entrypoint: ['true'],
      Labels: labels,
      HostConfig: { AutoRemove: false },
    },
    { name },
  );
  await ended.start();
  await ended.wait({ condition: 'not-running' });

  // Act
  const token = await untilAborted(
    new Mutex(fixture.store()).acquire(
      'report:daily',
      async (lease) => lease.token.value,
    ),
    t.signal,
  );

  // Assert: the claim that ended did not keep the key from the waiter.
  assert.ok(token > holder.token);
});

test("a holder whose list missed a stale minter's new rung still gets a token above the previous holder's", async (t) => {
  // Arrange: a rung far above the engine time, so that each mint takes the highest rung + 1, not the engine time.
  // The test makes it, because no operation of the store moves the clock of the engine.
  await using fixture = await engine();
  const labelled = { label: [`${namespaceLabel}=${fixture.namespace}`] };
  const mutex = new Mutex(fixture.store());
  await mutex.acquire('report:daily', async () => {});
  const [rung] = await fixture.docker.volumes.list({ filters: labelled });
  assert.ok(rung);
  await fixture.docker.volumes.create({
    Name: rung.Name.replace(/\d+$/, String(2n ** 52n)),
    Labels: rung.Labels ?? {},
  });
  const previous = await mutex.acquire(
    'report:daily',
    async (lease) => lease.token.value,
  );
  const ladder = async () =>
    (await fixture.docker.volumes.list({ filters: labelled })).map(({ Name }) =>
      BigInt(Name.slice(Name.lastIndexOf('-') + 1)),
    );
  assert.deepEqual(await ladder(), [previous]);

  // Arrange: a stale minter read the ladder, the proxy keeps its create of a rung, and then its claim is removed.
  await using staleProxy = await engineProxy(fixture.docker);
  await using staleClient = await Docker.connect({
    clock: globalThis,
    host: staleProxy.host,
  });
  const staleRung = staleProxy.holdRequestsFrom(/^POST \S*\/volumes\/create /);
  const stale = new Mutex(fixture.store(staleClient)).acquire(
    'report:daily',
    async (lease) => lease.token.value,
  );
  stale.catch(() => {});
  await staleRung.reached;
  const [claim, ...others] = await fixture.docker.containers.list({
    all: true,
    filters: labelled,
  });
  assert.ok(claim && others.length === 0);
  await (
    await fixture.docker.containers.find(claim.Id)
  )?.remove({ force: true });

  // Arrange: the next holder gets the claim, reads the same ladder, and the proxy keeps its create of a rung.
  await using nextProxy = await engineProxy(fixture.docker);
  await using nextClient = await Docker.connect({
    clock: globalThis,
    host: nextProxy.host,
  });
  const nextRung = nextProxy.holdRequestsFrom(/^POST \S*\/volumes\/create /);
  const next = new Mutex(fixture.store(nextClient)).acquire(
    'report:daily',
    async (lease) => lease.token.value,
  );
  next.catch(() => {});
  await nextRung.reached;

  // Act: the stale minter creates the rung above the previous token and removes the rung of the previous holder, and then the next holder creates its rung.
  staleRung.release();
  await waitFor(async () => assert.ok(!(await ladder()).includes(previous)), {
    interval: 5,
    signal: t.signal,
  });
  nextRung.release();
  const token = await untilAborted(next, t.signal);

  // Assert
  assert.ok(
    token > previous,
    `The next holder got ${token} after the previous holder got ${previous}`,
  );
  // The stale minter takes the key after the next holder, so that no request of it is open at the disposal.
  await untilAborted(
    stale.catch(() => {}),
    t.signal,
  );
});

test('two stores on one engine never run tasks of one key at the same time', async () => {
  // Arrange: two stores, each with its own client, as two machines have.
  await using fixture = await engine();
  await using other = await Docker.connect({
    clock: globalThis,
    environment: process.env,
  });
  const mutexes = [new Mutex(fixture.store()), new Mutex(fixture.store(other))];
  let inside = 0;
  let most = 0;
  const tokens: bigint[] = [];

  // Act
  await Promise.all(
    [0, 1, 2, 3, 4, 5].map((index) =>
      mutexes[index % 2]?.acquire('report:daily', async (lease) => {
        inside += 1;
        most = Math.max(most, inside);
        tokens.push(lease.token.value);
        await delay(20);
        inside -= 1;
      }),
    ),
  );

  // Assert
  assert.equal(most, 1, 'Two tasks of one key ran at the same time');
  assert.equal(tokens.length, 6);
  assert.ok(
    tokens.every((token, index) => index === 0 || token > tokens[index - 1]!),
    `The tokens did not increase in grant order: ${tokens.join(', ')}`,
  );
});

test('a waiter gets the key when the holder releases it', async (t) => {
  // Arrange
  await using fixture = await engine();
  await using other = await Docker.connect({
    clock: globalThis,
    environment: process.env,
  });
  const holder = await hold(new Mutex(fixture.store()), 'report:daily');
  const waiting = new Mutex(fixture.store(other)).acquire(
    'report:daily',
    async (lease) => lease.token.value,
  );
  const whileHeld = await Promise.race([
    waiting.then(() => 'settled'),
    delay(500, 'pending'),
  ]);

  // Act
  await holder.release();
  const token = await untilAborted(waiting, t.signal);

  // Assert
  assert.equal(whileHeld, 'pending');
  assert.ok(token > holder.token);
});

test('tryAcquire gives up on a held key and takes a free one', async () => {
  // Arrange
  await using fixture = await engine();
  await using other = await Docker.connect({
    clock: globalThis,
    environment: process.env,
  });
  const store = fixture.store(other);
  const holder = await hold(new Mutex(fixture.store()), 'report:daily');

  // Act
  const whileHeld = await store.tryAcquire('report:daily');
  await holder.release();
  const afterRelease = await store.tryAcquire('report:daily');
  await afterRelease?.[Symbol.asyncDispose]();

  // Assert
  assert.equal(whileHeld, undefined);
  assert.ok(afterRelease && afterRelease.token.value > holder.token);
});

test('isHeld tells a held key from a free one and creates nothing', async () => {
  // Arrange
  await using fixture = await engine();
  const store = fixture.store();
  const labelled = { label: [`${namespaceLabel}=${fixture.namespace}`] };

  // Act
  const free = await store.isHeld('report:daily');
  const containers = await fixture.docker.containers.list({
    all: true,
    filters: labelled,
  });
  const volumes = await fixture.docker.volumes.list({ filters: labelled });
  const holder = await hold(new Mutex(fixture.store()), 'report:daily');
  const rungsBefore = await fixture.docker.volumes.list({
    filters: labelled,
  });
  const held = await store.isHeld('report:daily');
  const rungsAfter = await fixture.docker.volumes.list({ filters: labelled });
  await holder.release();
  const released = await store.isHeld('report:daily');
  const rungsReleased = await fixture.docker.volumes.list({
    filters: labelled,
  });

  // Assert
  assert.equal(free, false);
  assert.deepEqual([containers.length, volumes.length], [0, 0]);
  assert.equal(held, true);
  assert.deepEqual(
    rungsAfter.map(({ Name }) => Name),
    rungsBefore.map(({ Name }) => Name),
    'A look at a held key must not mint a token',
  );
  assert.deepEqual(
    rungsReleased.map(({ Name }) => Name),
    rungsBefore.map(({ Name }) => Name),
    'A look at a free key must not mint a token',
  );
  assert.equal(released, false);
});

test('the tokens of one key increase', async () => {
  // Arrange
  await using fixture = await engine();
  const mutex = new Mutex(fixture.store());

  // Act
  const tokens: bigint[] = [];
  for (let grant = 0; grant < 3; grant += 1) {
    tokens.push(
      await mutex.acquire('report:daily', async (lease) => lease.token.value),
    );
  }

  // Assert
  assert.ok(
    tokens.every((token, index) => index === 0 || token > tokens[index - 1]!),
    `The tokens did not increase: ${tokens.join(', ')}`,
  );
});

test('a cancelled acquire rejects with the reason of its signal and leaves no claim', async (t) => {
  // Arrange
  await using fixture = await engine();
  await using other = await Docker.connect({
    clock: globalThis,
    environment: process.env,
  });
  const holder = await hold(new Mutex(fixture.store()), 'report:daily');
  const cancel = new AbortController();
  const reason = new Error('cancelled');
  const waiting = new Mutex(fixture.store(other)).acquire(
    'report:daily',
    async () => 'ran',
    { signal: cancel.signal },
  );
  await delay(300);

  // Act
  cancel.abort(reason);
  const failure = await untilAborted(waiting, t.signal).then(
    () => undefined,
    (error: unknown) => error,
  );
  await holder.release();

  // Assert
  assert.equal(failure, reason);
  assert.equal(await fixture.store().isHeld('report:daily'), false);
});

test('two namespaces do not share a key or its tokens', async (t) => {
  // Arrange: the second namespace is on the same engine. The ladder of the first namespace has a rung far above the engine time.
  await using first = await engine();
  await using second = await engine();
  const firstMutex = new Mutex(first.store());
  await firstMutex.acquire('report:daily', async () => {});
  const [rung] = await first.docker.volumes.list({
    filters: { label: [`${namespaceLabel}=${first.namespace}`] },
  });
  assert.ok(rung);
  const high = 2n ** 52n;
  await first.docker.volumes.create({
    Name: rung.Name.replace(/\d+$/, String(high)),
    Labels: rung.Labels ?? {},
  });
  const holder = await hold(firstMutex, 'report:daily');

  // Act
  const other = await untilAborted(
    new Mutex(second.store()).acquire(
      'report:daily',
      async (lease) => lease.token.value,
    ),
    t.signal,
  );
  await holder.release();
  const next = await firstMutex.acquire(
    'report:daily',
    async (lease) => lease.token.value,
  );

  // Assert
  assert.ok(
    other < high,
    `The second namespace got ${other}, above the ladder of the first`,
  );
  assert.equal(holder.token, high + 1n);
  assert.equal(next, high + 2n);
});

test('every claim and rung carries the labels of the caller', async () => {
  // Arrange
  await using fixture = await engine();
  const store = new DockerEngineStore({
    docker: fixture.docker,
    image,
    namespace: fixture.namespace,
    heartbeatInterval,
    labels: { 'com.example.owner': fixture.namespace },
    clock: globalThis,
  });

  // Act
  const holder = await hold(new Mutex(store), 'report:daily');
  const filters = { label: [`com.example.owner=${fixture.namespace}`] };
  const claims = await fixture.docker.containers.list({ all: true, filters });
  const rungs = await fixture.docker.volumes.list({ filters });
  await holder.release();

  // Assert
  assert.deepEqual([claims.length, rungs.length], [1, 1]);
});

test('the labels of the store replace the labels of the caller with the same names', async () => {
  // Arrange: each label of the store also comes from the caller, with another value.
  await using fixture = await engine();
  const other = `${fixture.namespace}-other`;
  const mutex = new Mutex(
    new DockerEngineStore({
      docker: fixture.docker,
      image,
      namespace: fixture.namespace,
      heartbeatInterval,
      labels: {
        [namespaceLabel]: other,
        'zukhruf.mutex.key': other,
        'zukhruf.mutex.token': other,
      },
      clock: globalThis,
    }),
  );
  await mutex.acquire('report:daily', async () => {});

  // Act
  const holder = await hold(mutex, 'report:daily');
  const filters = { label: [`${namespaceLabel}=${fixture.namespace}`] };
  const claims = await fixture.docker.containers.list({ all: true, filters });
  const rungs = await fixture.docker.volumes.list({ filters });
  await holder.release();

  // Assert
  assert.deepEqual(
    claims.map(({ Labels }) => Labels?.['zukhruf.mutex.key']),
    ['report:daily'],
  );
  assert.equal(
    rungs.length,
    1,
    'The second mint must find the rung of the first and remove it',
  );
});

/**
 * A test file that takes a key through the DockerEngineStore case of the
 * lock-store matrix, writes the location of its fixture to `statePath`, and
 * kills its own process while it holds the key.
 */
const killedHolderSource = (statePath: string) => `
	import { test } from 'node:test';
	import { writeFileSync } from 'node:fs';
	import { Mutex } from ${JSON.stringify(new URL('../../index.ts', import.meta.url).href)};
	import { subject as store } from ${JSON.stringify(new URL('../../testing/subjects/docker-engine.ts', import.meta.url).href)};
	test('holds a key until its process is killed', async () => {
		const fixture = await store.fixture(process.env);
		await new Mutex(store.open(fixture.location).store).acquire('report:daily', async () => {
			writeFileSync(${JSON.stringify(statePath)}, fixture.location);
			process.kill(process.pid, 'SIGKILL');
		});
	});
`;

/**
 * Resolves when each of `containers` and `volumes` has its destroy event
 * since `since`, in seconds. `since` replays the events that came before the
 * call, so an object that went first is not missed. The wait ends when
 * `signal` aborts.
 */
async function destroyed(
  docker: Docker,
  since: number,
  containers: string[],
  volumes: string[],
  signal: AbortSignal,
): Promise<void> {
  const left = new Set([...containers, ...volumes]);
  if (left.size === 0) return;
  for await (const { Actor } of docker.events({
    since,
    filters: { type: ['container', 'volume'], event: ['destroy'] },
    signal,
  })) {
    if (Actor?.ID !== undefined) left.delete(Actor.ID);
    if (left.size === 0) return;
  }
}

test('a rung left by a killed test process is removed by the run’s reaper after the run ends', async (t) => {
  await using docker = await Docker.connect({
    clock: globalThis,
    environment: process.env,
  });
  if (!['unix:', 'npipe:'].includes(new URL(docker.host).protocol)) {
    t.skip(
      `the global setup of the run starts the shared database servers of the lock-store matrix on the engine ${docker.host}`,
    );
    return;
  }
  // Arrange: a run of its own, with its records in a scratch directory.
  await using directory = await new TemporaryFiles().directory('mutex-test-');
  const statePath = join(directory.path, 'state.json');
  const file = join(directory.path, 'killed-holder.test.mjs');
  await writeFile(file, killedHolderSource(statePath));
  let namespace: string | undefined;
  try {
    // Act: the test process dies while it holds the key, and the run ends.
    const since = Math.floor(Date.now() / 1000) - 1;
    const run = await promisify(execFile)(
      process.execPath,
      [
        '--test',
        `--test-global-setup=${fileURLToPath(import.meta.resolve('@zukhruf/testing/docker-global-setup'))}`,
        file,
      ],
      {
        timeout: 150_000,
        env: {
          ...process.env,
          XDG_STATE_HOME: join(directory.path, 'state'),
          // A runner started from a test process would otherwise run no file.
          NODE_TEST_CONTEXT: undefined,
          // This test runs in a run itself; the nested run must start its own.
          ZUKHRUF_TESTING_RUN_ID: undefined,
          ZUKHRUF_TESTING_RUN_DIR: undefined,
        },
      },
    ).catch((error: { stdout?: string; stderr?: string }) => error);
    const location = await readFile(statePath, 'utf8').catch(() => {
      throw new Error(
        `The test process did not take the key:\n${run.stdout}\n${run.stderr}`,
      );
    });
    const fixture: { namespace: string } = JSON.parse(location);
    namespace = fixture.namespace;

    // Assert
    const filters = { label: [`${namespaceLabel}=${namespace}`] };
    await destroyed(
      docker,
      since,
      (await docker.containers.list({ all: true, filters })).map(
        ({ Id }) => Id,
      ),
      (await docker.volumes.list({ filters })).map(({ Name }) => Name),
      t.signal,
    );
    const containers = await docker.containers.list({ all: true, filters });
    const volumes = await docker.volumes.list({ filters });
    assert.deepEqual(
      [containers.length, volumes.length],
      [0, 0],
      'The reaper of the run must remove the claims and rungs of a killed test process after the run ends',
    );
  } finally {
    if (namespace !== undefined) {
      const filters = { label: [`${namespaceLabel}=${namespace}`] };
      for (const { Id } of await docker.containers.list({
        all: true,
        filters,
      })) {
        await (await docker.containers.find(Id))?.remove({ force: true });
      }
      for (const { Name } of await docker.volumes.list({ filters })) {
        await (await docker.volumes.find(Name))?.remove({ force: true });
      }
    }
  }
});

test('a lost claim whose removal the engine refuses is a DockerEngineStoreWarning with its code, the key and the claim, and the failure as its cause', async (t) => {
  // Arrange: the store reaches the engine through a proxy, which answers each
  // removal of a container with an error of the engine, as no operation of the
  // store makes the engine refuse a removal.
  await using fixture = await engine();
  await using proxy = await engineProxy(fixture.docker);
  await using client = await Docker.connect({
    clock: globalThis,
    host: proxy.host,
  });
  const holder = await hold(new Mutex(fixture.store(client)), 'report:daily');
  const [claim] = await fixture.docker.containers.list({
    all: true,
    filters: { label: [`${namespaceLabel}=${fixture.namespace}`] },
  });
  assert.ok(claim);
  const refusal = JSON.stringify({ message: 'driver failed to remove' });
  proxy.answerRequestsWith(
    /^DELETE \S*\/containers\//,
    `HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(refusal)}\r\n\r\n${refusal}`,
  );
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => {
    if (warning.name === 'DockerEngineStoreWarning') warnings.push(warning);
  };
  process.on('warning', onWarning);
  try {
    // Act: the claim goes, so the holder loses it, and the store removes it.
    await (
      await fixture.docker.containers.find(claim.Id)
    )?.remove({ force: true });

    // Assert
    await waitFor(() => assert.equal(warnings.length, 1), {
      signal: t.signal,
    });
    const [warning] = warnings;
    assert.ok(warning instanceof DockerEngineStoreWarning);
    assert.deepEqual(
      { ...warning, message: warning.message },
      {
        name: 'DockerEngineStoreWarning',
        code: 'ZUKHRUF_MUTEX_DOCKER_CLAIM_REMOVE_FAILED',
        detail: `key: report:daily\ncontainer: ${claim.Id}`,
        message:
          'The removal of a lost claim failed, and the claim ends with its attach: driver failed to remove',
      },
    );
    assert.ok(Error.isError(warning.cause));
    assert.equal(warning.cause.message, 'driver failed to remove');
  } finally {
    process.off('warning', onWarning);
    // The holder lost its key, so its acquire rejects.
    await Promise.allSettled([holder.release()]);
  }
});
