import assert from 'node:assert/strict';
import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import spawn from 'nano-spawn';
import pg from 'pg';

import { ConnectionFailedError, Docker } from '@zukhruf/docker';

import { timebox } from '../async/index.ts';
import { TemporaryFiles } from '../fs/temporary-files.ts';
import { EngineProxy } from '../testing/engine-proxy.ts';
import { DockerTestbed } from './index.ts';

const image = 'alpine:latest';
/** The host of the engine that this process's context selects. */
const engine =
  (await Docker.contexts({ environment: process.env })).find(
    (context) => context.current,
  )?.host ?? '';
const proxyless = engine.startsWith('unix://')
  ? false
  : `the engine proxy forwards to a local unix:// engine only, not ${engine}`;
const library = JSON.stringify(new URL('./index.ts', import.meta.url).href);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Removes each container that carries `label=value`, shared servers too. */
async function removeLabelled(docker: Docker, label: string): Promise<void> {
  for (const { Id } of await docker.containers.list({
    all: true,
    filters: { label: [label] },
  }))
    await (await docker.containers.find(Id))?.remove({ force: true, v: true });
}

test(
  'a served database answers on 127.0.0.1 of this machine, and the engine publishes it on 127.0.0.1 only',
  { timeout: 180_000 },
  async () => {
    // Arrange
    const testbed = new DockerTestbed({ environment: process.env });

    // Act
    await using server = await testbed.serve(
      { Image: 'postgres:18-alpine', Env: ['POSTGRES_PASSWORD=test'] },
      {
        internalPort: 5432,
        healthy: ({ container }) =>
          timebox(
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
      inspected.NetworkSettings?.Ports?.['5432/tcp']?.map(
        ({ HostIp }) => HostIp,
      ),
      ['127.0.0.1'],
    );
    assert.equal(server.host, '127.0.0.1');
  },
);

test(
  'a started container gets the default limits, or the Memory and NanoCpus of its body',
  { timeout: 60_000 },
  async () => {
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
  },
);

test(
  'a started container runs with the hostname, environment, labels, binds, tmpfs and IPC namespace of its body, and the run label',
  { timeout: 60_000 },
  async () => {
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
  },
);

test(
  'run gives the output and a non-zero exit code of a container, and removes it',
  { timeout: 60_000 },
  async () => {
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
  },
);

test(
  'a served server whose readiness fails is removed, and the failure has the readiness error as its cause',
  { timeout: 60_000 },
  async (t) => {
    // Arrange
    const testbed = new DockerTestbed({ environment: process.env });
    const client = await testbed.client();
    const scope = randomUUID();
    const label = `dev.zukhruf.testing.verification=${scope}`;
    const served: string[] = [];
    try {
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
      assert.ok(failure instanceof Error);
      assert.deepEqual(failure.cause, new Error('not ready'));
      assert.equal(served.length, 1);
      await t.waitFor(
        async () =>
          assert.equal(
            await client.containers.find(served[0] ?? ''),
            undefined,
          ),
        { timeout: 10_000 },
      );
    } finally {
      await removeLabelled(client, label);
    }
  },
);

test(
  'a served server whose container exits before it is ready is removed, and the failure has its output and the readiness error as its cause',
  { timeout: 60_000 },
  async (t) => {
    // Arrange: the container lives long enough to publish its port, then exits.
    const testbed = new DockerTestbed({ environment: process.env });
    const client = await testbed.client();
    const scope = randomUUID();
    const readiness = new Error('the server stopped');
    const served: string[] = [];
    try {
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
              await timebox(async () => {
                const { State } = await container.inspect();
                if (State?.Running) throw new Error('still running');
              });
              throw readiness;
            },
          },
        )
        .then(
          () => assert.fail('serve resolved'),
          (error: unknown) => error,
        );

      // Assert
      assert.ok(failure instanceof Error);
      assert.match(failure.message, new RegExp(`printed-${scope}`));
      assert.equal(failure.cause, readiness);
      assert.equal(served.length, 1);
      await t.waitFor(
        async () =>
          assert.equal(
            await client.containers.find(served[0] ?? ''),
            undefined,
          ),
        { timeout: 10_000 },
      );
    } finally {
      await removeLabelled(client, `dev.zukhruf.testing.verification=${scope}`);
    }
  },
);

test(
  'handles keep the engine of the first acquisition when the environment changes',
  { timeout: 60_000 },
  async () => {
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
  },
);

test(
  'an engine that does not answer fails the first acquisition with Docker is required, and the connection failure as cause',
  { timeout: 30_000 },
  async () => {
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
    assert.ok(failure instanceof Error);
    assert.equal(
      failure.message,
      'Docker is required for container-backed tests',
    );
    assert.ok(failure.cause instanceof ConnectionFailedError);
  },
);

test(
  'start pulls an image that the engine does not have',
  { timeout: 180_000 },
  async () => {
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
  },
);

test(
  'two processes that reuse one configuration get one server, which disposal leaves running, and a container with the name but not the configuration is refused',
  { timeout: 120_000 },
  async () => {
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
      console.log(server.container.id);
    `;
    const reuse = () =>
      spawn(process.execPath, ['--input-type=module', '--eval', reuser]);
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
  },
);

test(
  'a create in flight has a creating record in the run, and the record is gone once the engine answered',
  { skip: proxyless, timeout: 60_000 },
  async () => {
    // Arrange: an engine that holds the create until the test lets it go.
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-creating-',
    );
    await using proxy = await EngineProxy.start(engine);
    const arrived = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    proxy.intercept('POST', '/containers/create', () => {
      arrived.resolve();
      return gate.promise;
    });
    const testbed = new DockerTestbed({
      environment: {
        DOCKER_HOST: proxy.host,
        DOCKER_CONFIG: process.env.DOCKER_CONFIG,
        ZUKHRUF_TESTING_RUN_ID: randomUUID(),
        ZUKHRUF_TESTING_RUN_DIR: directory.path,
      },
    });
    // The run directory is the seam the global teardown reads: it keeps a
    // run while a creating record remains (covered by its own tests).
    const creating = async () =>
      (await readdir(directory.path)).filter((file) =>
        file.startsWith('creating-'),
      );
    const started = testbed.start({ Image: image, Cmd: ['sleep', '60'] });
    try {
      // Act
      await arrived.promise;

      // Assert
      assert.equal((await creating()).length, 1);
      gate.resolve();
      await started;
      assert.deepEqual(await creating(), []);
    } finally {
      // The container carries this test's own run label: no teardown sweeps it.
      gate.resolve();
      await (await started.catch(() => undefined))?.[Symbol.asyncDispose]();
    }
  },
);

test(
  'the ssh connections of a process that is killed with idle connections, one after an exec, exit within 15 s',
  {
    skip: engine.startsWith('ssh://')
      ? false
      : `the current context selects ${engine}, not an ssh:// engine`,
    timeout: 120_000,
  },
  async (t) => {
    // Arrange: a process with idle connections to the engine, one of them
    // used by an exec, that waits to be killed.
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
    const ssh: number[] = [];
    try {
      const [line] = await once(createInterface(child.stdout), 'line');
      const children = await spawn('ps', ['-Ao', 'pid=,ppid=,comm=']);
      for (const row of children.stdout.split('\n')) {
        const [pid, ppid, command] = row.trim().split(/\s+/);
        if (Number(ppid) === child.pid && command?.endsWith('ssh'))
          ssh.push(Number(pid));
      }
      assert.ok(ssh.length > 0, 'the process has ssh connections');

      // Act
      child.kill('SIGKILL');
      await exited;

      // Assert
      await t.waitFor(
        () =>
          assert.deepEqual(
            ssh.filter((pid) => alive(pid)),
            [],
          ),
        { timeout: 15_000, interval: 100 },
      );
      await (
        await client.containers.find(String(line))
      )?.remove({
        force: true,
        v: true,
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      for (const pid of ssh.filter((each) => alive(each)))
        process.kill(pid, 'SIGKILL');
    }
  },
);
