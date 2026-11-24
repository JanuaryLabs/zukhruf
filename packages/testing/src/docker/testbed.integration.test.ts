import assert from 'node:assert/strict';
import { execFile, spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { promisify } from 'node:util';

import pg from 'pg';

import { ConnectionFailedError, Docker } from '@zukhruf/docker';
import { TemporaryFiles } from '@zukhruf/fs';

import { retryUntilReady } from '../async/index.ts';
import { waitFor } from '../async/wait-for.ts';
import { engine, proxyless } from '../testing/current-engine.ts';
import { EngineProxy } from '../testing/engine-proxy.ts';
import { library } from '../testing/global-setup-run.ts';
import { DockerTestbed } from './index.ts';

const image = 'alpine:latest';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes each container that carries `label=value`. A reuse() server has no
 * run label, and the global teardown keeps the servers of this version, so only
 * this removes a server that one test made.
 */
async function removeLabelled(docker: Docker, label: string): Promise<void> {
  for (const { Id } of await docker.containers.list({
    all: true,
    filters: { label: [label] },
  }))
    await (await docker.containers.find(Id))?.remove({ force: true, v: true });
}

test('a served database answers on 127.0.0.1 of this machine, and the engine publishes it on 127.0.0.1 only', async () => {
  // Arrange
  const testbed = new DockerTestbed({ environment: process.env });

  // Act
  await using server = await testbed.serve(
    { Image: 'postgres:18-alpine', Env: ['POSTGRES_PASSWORD=test'] },
    {
      internalPort: 5432,
      healthy: ({ container }) =>
        retryUntilReady(
          async () => {
            const { exitCode, output } = await container.exec({
              Cmd: ['pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
            });
            if (exitCode !== 0) throw new Error(output);
          },
          { maxRetryTime: 60_000 },
        ),
    },
  );

  // Assert
  const client = new pg.Client({
    host: server.host,
    port: server.port,
    user: 'postgres',
    password: 'test',
    connectionTimeoutMillis: 3_000,
  });
  try {
    await client.connect();
    assert.deepEqual((await client.query('SELECT 42 AS value')).rows, [
      { value: 42 },
    ]);
  } finally {
    await client.end();
  }
  const inspected = await server.container.inspect();
  assert.deepEqual(
    inspected.NetworkSettings?.Ports?.['5432/tcp']?.map(({ HostIp }) => HostIp),
    ['127.0.0.1'],
  );
  assert.equal(server.host, '127.0.0.1');
});

test('a started container gets the default limits, or the Memory and NanoCpus of its body', async () => {
  // Arrange
  const testbed = new DockerTestbed({ environment: process.env });

  // Act
  await using defaults = await testbed.start({
    Image: image,
    Cmd: ['sleep', '60'],
  });
  await using given = await testbed.start({
    Image: image,
    Cmd: ['sleep', '60'],
    HostConfig: { Memory: 512 * 1024 ** 2, NanoCpus: 500_000_000 },
  });

  // Assert
  const limits = async (container: typeof defaults) => {
    const { HostConfig } = await container.inspect();
    return { memory: HostConfig?.Memory, cpus: HostConfig?.NanoCpus };
  };
  assert.deepEqual(await limits(defaults), {
    memory: 1024 ** 3,
    cpus: 1_000_000_000,
  });
  assert.deepEqual(await limits(given), {
    memory: 512 * 1024 ** 2,
    cpus: 500_000_000,
  });
});

test('a started container runs with the hostname, environment, labels, binds, tmpfs and IPC namespace of its body, and the run label', async () => {
  // Arrange
  const testbed = new DockerTestbed({ environment: process.env });
  await using volume = await testbed.volume();
  const scope = randomUUID();

  // Act
  await using container = await testbed.start({
    Image: image,
    Cmd: ['sleep', '60'],
    Hostname: 'fixture-host',
    Env: ['GREETING=hello world'],
    Labels: { 'dev.zukhruf.testing.verification': scope },
    HostConfig: {
      Binds: [`${volume.name}:/data`, `${volume.name}:/readonly:ro`],
      Tmpfs: { '/scratch': 'rw,size=8m' },
      IpcMode: 'host',
    },
  });

  // Assert
  const shell = (script: string) =>
    container.exec({ Cmd: ['sh', '-c', script] });
  assert.equal((await shell('hostname')).stdout, 'fixture-host\n');
  assert.equal((await shell('echo "$GREETING"')).stdout, 'hello world\n');
  assert.equal((await shell('echo kept > /data/file')).exitCode, 0);
  assert.equal((await shell('cat /readonly/file')).stdout, 'kept\n');
  assert.notEqual((await shell('touch /readonly/other')).exitCode, 0);
  assert.match(
    (await shell('grep " /scratch " /proc/mounts')).stdout,
    /^tmpfs \/scratch tmpfs rw.*size=8192k/,
  );
  const inspected = await container.inspect();
  assert.equal(inspected.HostConfig?.IpcMode, 'host');
  const labels = inspected.Config?.Labels ?? {};
  assert.deepEqual(
    {
      verification: labels['dev.zukhruf.testing.verification'],
      run: labels['dev.zukhruf.testing.run'],
    },
    { verification: scope, run: process.env.ZUKHRUF_TESTING_RUN_ID },
  );
  assert.ok(process.env.ZUKHRUF_TESTING_RUN_ID, 'the test runs in a run');
});

test('run gives the output and a non-zero exit code of a container, and removes it', async () => {
  // Arrange
  const testbed = new DockerTestbed({ environment: process.env });
  const scope = randomUUID();

  // Act: the container's hostname is the start of its id.
  const result = await testbed.run({
    Image: image,
    Cmd: ['sh', '-c', 'echo printed; hostname >&2; exit 3'],
    Labels: { 'dev.zukhruf.testing.verification': scope },
  });

  // Assert
  const id = result.stderr.trim();
  assert.match(id, /^[\da-f]{12}$/);
  assert.deepEqual(
    { exitCode: result.exitCode, stdout: result.stdout },
    { exitCode: 3, stdout: 'printed\n' },
  );
  const client = await testbed.client();
  assert.equal(await client.containers.find(id), undefined);
});

test('a served server whose readiness fails is removed, and the failure has the readiness error as its cause', async (t) => {
  // Arrange
  const testbed = new DockerTestbed({ environment: process.env });
  const client = await testbed.client();
  const scope = randomUUID();
  const served: string[] = [];

  // Act
  const failure = await testbed
    .serve(
      {
        Image: image,
        Cmd: ['sleep', '60'],
        Labels: { 'dev.zukhruf.testing.verification': scope },
      },
      {
        internalPort: 8080,
        healthy: ({ container }) => {
          served.push(container.id);
          throw new Error('not ready');
        },
      },
    )
    .then(
      () => assert.fail('serve resolved'),
      (error: unknown) => error,
    );

  // Assert
  assert.ok(Error.isError(failure));
  assert.deepEqual(failure.cause, new Error('not ready'));
  assert.equal(served.length, 1);
  await waitFor(
    async () =>
      assert.equal(await client.containers.find(served[0] ?? ''), undefined),
    { signal: t.signal },
  );
});

test('a served server whose container exits before it is ready is removed, and the failure has its output and its exit code as its cause', async (t) => {
  // Arrange: the container lives long enough to publish its port, then exits.
  const testbed = new DockerTestbed({ environment: process.env });
  const client = await testbed.client();
  const scope = randomUUID();
  const served: string[] = [];

  // Act
  const failure = await testbed
    .serve(
      {
        Image: image,
        Cmd: ['sh', '-c', `echo printed-${scope}; sleep 1; exit 3`],
        Labels: { 'dev.zukhruf.testing.verification': scope },
      },
      {
        internalPort: 8080,
        healthy: async ({ container }) => {
          served.push(container.id);
          await retryUntilReady(async () => {
            const { State } = await container.inspect();
            if (State?.Running) throw new Error('still running');
          });
          throw new Error('the server stopped');
        },
      },
    )
    .then(
      () => assert.fail('serve resolved'),
      (error: unknown) => error,
    );

  // Assert
  assert.ok(Error.isError(failure));
  assert.match(failure.message, new RegExp(`printed-${scope}`));
  assert.ok(Error.isError(failure.cause));
  assert.match(
    failure.cause.message,
    /exited with code 3 before it was ready:\n/,
  );
  assert.equal(served.length, 1);
  await waitFor(
    async () =>
      assert.equal(await client.containers.find(served[0] ?? ''), undefined),
    { signal: t.signal },
  );
});

test('handles keep the engine of the first acquisition when the environment changes', async () => {
  // Arrange
  const environment = { ...process.env };
  const testbed = new DockerTestbed({ environment });
  await using first = await testbed.start({
    Image: image,
    Cmd: ['sleep', '60'],
  });
  const host = (await testbed.client()).host;

  // Act: the environment now names an engine that does not exist.
  environment.DOCKER_HOST = 'unix:///nonexistent/docker-test.sock';
  delete environment.DOCKER_CONTEXT;
  await using second = await testbed.start({
    Image: image,
    Cmd: ['sleep', '60'],
  });

  // Assert
  assert.equal((await testbed.client()).host, host);
  assert.equal((await second.inspect()).State?.Running, true);
  assert.notEqual(second.id, first.id);
});

test('an engine that does not answer fails the first acquisition with Docker is required, and the connection failure as cause', async () => {
  // Arrange
  const testbed = new DockerTestbed({
    environment: {
      DOCKER_HOST: 'unix:///nonexistent/docker-test.sock',
      DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    },
  });

  // Act
  const failure = await testbed.start({ Image: image }).then(
    () => assert.fail('the acquisition succeeded'),
    (error: unknown) => error,
  );

  // Assert
  assert.ok(Error.isError(failure));
  assert.equal(
    failure.message,
    'Docker is required for container-backed tests',
  );
  assert.ok(failure.cause instanceof ConnectionFailedError);
});

test('start pulls an image that the engine does not have', async () => {
  // Arrange: only this test uses this tag, so it can remove the image.
  const pulled = 'busybox:1.37.0-uclibc';
  const testbed = new DockerTestbed({ environment: process.env });
  const client = await testbed.client();
  await client.images.remove(pulled, { force: true });
  assert.equal(await client.images.inspect(pulled), undefined);
  try {
    // Act
    await using container = await testbed.start({
      Image: pulled,
      Cmd: ['sleep', '60'],
    });

    // Assert
    assert.equal(
      (await container.exec({ Cmd: ['true'] })).exitCode,
      0,
      'the container runs',
    );
    assert.notEqual(await client.images.inspect(pulled), undefined);
  } finally {
    await client.images.remove(pulled, { force: true });
  }
});

test('two processes that reuse one configuration get one server, which disposal leaves running, and a container with the name but not the configuration is refused', async () => {
  // Arrange
  const testbed = new DockerTestbed({ environment: process.env });
  const client = await testbed.client();
  const scope = randomUUID();
  const label = `dev.zukhruf.testing.verification=${scope}`;
  const body = {
    Image: image,
    Cmd: ['sh', '-c', 'while true; do nc -l -p 8080 < /dev/null; done'],
    Labels: { 'dev.zukhruf.testing.verification': scope },
  };
  const reuser = `
      import { DockerTestbed } from ${library};
      const testbed = new DockerTestbed({ environment: process.env });
      const server = await testbed.reuse(${JSON.stringify(body)}, { internalPort: 8080 });
      await server[Symbol.asyncDispose]();
      process.stdout.write(server.container.id);
    `;
  const reuse = () =>
    promisify(execFile)(process.execPath, [
      '--input-type=module',
      '--eval',
      reuser,
    ]);
  try {
    // Act
    const [first, second] = await Promise.all([reuse(), reuse()]);

    // Assert
    assert.equal(first.stdout, second.stdout);
    const shared = await client.containers.find(first.stdout);
    assert.equal((await shared?.inspect())?.State?.Running, true);

    // Arrange: a container that has the name and other labels.
    const name = `zukhruf-testing-foreign-${scope}`;
    await using _foreign = await client.containers.create(
      {
        Image: image,
        Cmd: ['sleep', '60'],
        Labels: { 'dev.zukhruf.testing.verification': scope },
      },
      { name },
    );

    // Act + Assert
    await assert.rejects(
      testbed.reuse(body, { internalPort: 8080, name }),
      new Error(
        `Container ${name} does not match the shared test configuration`,
      ),
    );
  } finally {
    await removeLabelled(client, label);
  }
});

test('two processes that need one absent image at once build it once, and the other uses that image', async () => {
  // Arrange: each build tags its image also with a tag of its own process, so
  // the engine keeps a record of each build that ran.
  const testbed = new DockerTestbed({ environment: process.env });
  const client = await testbed.client();
  await client.images.pull('busybox:1.37.0');
  const repository = 'zukhruf-testing-build-verification';
  const scope = randomUUID();
  const tag = `${repository}:${scope}`;
  const own = (builder: number) => `${repository}:${scope}-${builder}`;
  const builder = (index: number) => {
    const child = spawnProcess(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
        import { once } from 'node:events';
        import { createInterface } from 'node:readline';
        import { DockerTestbed } from ${library};
        const testbed = new DockerTestbed({ environment: process.env });
        const docker = await testbed.client();
        console.log('ready');
        const go = createInterface({ input: process.stdin });
        await once(go, 'line');
        go.close();
        await testbed.image(${JSON.stringify(tag)}, (engine) =>
          engine.images.build(
            { files: [{ path: 'Dockerfile', data: 'FROM busybox:1.37.0\\nRUN true\\n' }] },
            { t: [${JSON.stringify(tag)}, ${JSON.stringify(own(index))}], labels: { 'dev.zukhruf.testing.verification': ${JSON.stringify(scope)} }, nocache: true },
          ),
        );
        console.log((await docker.images.inspect(${JSON.stringify(tag)}))?.Id);
        `,
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    return {
      child,
      exited: once(child, 'exit'),
      lines: createInterface(child.stdout)[Symbol.asyncIterator](),
    };
  };
  const builders = [builder(0), builder(1)];
  try {
    for (const { lines } of builders)
      assert.equal((await lines.next()).value, 'ready');

    // Act
    for (const { child } of builders) child.stdin.end('go\n');
    const seen = await Promise.all(
      builders.map(async ({ lines, exited }) => {
        const { value } = await lines.next();
        assert.deepEqual(await exited, [0, null]);
        return value;
      }),
    );

    // Assert
    const built = (
      await Promise.all(
        [0, 1].map((index) => client.images.inspect(own(index))),
      )
    ).filter((image) => image !== undefined);
    assert.equal(built.length, 1, 'exactly one build ran');
    const image = (await client.images.inspect(tag))?.Id;
    assert.equal(image, built[0]?.Id);
    assert.deepEqual(seen, [image, image]);
  } finally {
    for (const { child, exited } of builders) {
      child.kill('SIGKILL');
      await exited;
    }
    for (const reference of [tag, own(0), own(1)])
      await client.images.remove(reference, { force: true });
  }
});

test(
  'a test process of a run on an ssh:// engine starts no ssh process: its engine calls and an exec go through the run’s connection (ADR 0024)',
  {
    skip: engine.startsWith('ssh://')
      ? false
      : `the current context selects ${engine}, not an ssh:// engine`,
  },
  async () => {
    // Arrange: a process that creates a container and runs an exec in it.
    const child = spawnProcess(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
        import { DockerTestbed } from ${library};
        const testbed = new DockerTestbed({ environment: process.env });
        const container = await testbed.start({ Image: ${JSON.stringify(image)}, Cmd: ['sleep', '120'] });
        await container.exec({ Cmd: ['true'] });
        console.log(container.id);
        setInterval(() => {}, 1_000);
        `,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const exited = once(child, 'exit');
    const testbed = new DockerTestbed({ environment: process.env });
    const client = await testbed.client();
    try {
      const [line] = await once(createInterface(child.stdout), 'line');

      // Act
      const children = await promisify(execFile)('ps', [
        '-Ao',
        'pid=,ppid=,comm=',
      ]);

      // Assert
      const ssh = children.stdout.split('\n').filter((row) => {
        const [, ppid, command] = row.trim().split(/\s+/);
        return Number(ppid) === child.pid && command?.endsWith('ssh');
      });
      assert.deepEqual(ssh, []);
      await (
        await client.containers.find(String(line))
      )?.remove({
        force: true,
        v: true,
      });
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  },
);
