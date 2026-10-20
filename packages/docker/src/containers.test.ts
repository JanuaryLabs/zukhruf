import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

import {
  BindSourceNotFoundError,
  ContainerNotFoundError,
  ContainerNotRunningError,
  ContainerRunningError,
  Docker,
  DockerEngineError,
  ImageNotFoundError,
  NameConflictError,
  NetworkNotFoundError,
} from './index.ts';
import { fakeEngine } from './testing/fake-engine.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';

const TEST_LABEL = 'dev.zukhruf.docker.test';
const IMAGE = 'alpine:3';

/** The engine that the environment of the test run selects, with alpine:3 on it. */
async function connect(): Promise<Docker> {
  const docker = await Docker.connect({
    environment: process.env,
    signal: AbortSignal.timeout(15_000),
  });
  if (!(await docker.images.inspect(IMAGE))) await docker.images.pull(IMAGE);
  return docker;
}

/** A body of alpine:3 with the label of this test run, that sleeps when it starts. */
function sleeper(run: string) {
  return {
    Image: IMAGE,
    Cmd: ['sleep', '300'],
    Labels: { [TEST_LABEL]: run },
  };
}

/** Removes each container with the label of this test run. */
async function removeLabeled(docker: Docker, run: string): Promise<void> {
  const left = await docker.containers.list({
    all: true,
    filters: { label: [`${TEST_LABEL}=${run}`] },
  });
  for (const summary of left) {
    const container = await docker.containers.find(summary.Id);
    await container?.remove({ force: true, v: true });
  }
}

describe('a handle owns its container only when it created it', () => {
  test('disposal of the OwnedContainer from create() removes the container', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      let id = '';
      {
        await using owned = await docker.containers.create(sleeper(run));
        await owned.start();
        id = owned.id;

        // Act: the scope ends.
      }

      // Assert
      assert.equal(await docker.containers.find(id), undefined);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('a Container from find() has no disposal and keeps acting on the first container after its name is reused', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const name = `zukhruf-test-${run}`;
    try {
      const first = await docker.containers.create(sleeper(run), { name });
      const found = await docker.containers.find(name);
      assert.ok(found);
      await first.remove({ force: true });
      const second = await docker.containers.create(sleeper(run), { name });

      // Act
      const inspected = await found.inspect().then(
        () => undefined,
        (error: unknown) => error,
      );
      const disposed = await (async () => {
        // @ts-expect-error A Container has no Symbol.asyncDispose.
        await using _unowned = found;
      })().then(
        () => undefined,
        (error: unknown) => error,
      );

      // Assert
      assert.ok(inspected instanceof ContainerNotFoundError);
      assert.equal(inspected.container, first.id);
      assert.ok(disposed instanceof TypeError);
      assert.equal(found.id, first.id);
      assert.equal((await second.inspect()).Id, second.id);
    } finally {
      await removeLabeled(docker, run);
    }
  });
});

describe('answers that are not errors', () => {
  test('start() of a running container and stop() of a stopped one resolve, and remove() of a missing one resolves', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await docker.containers.create(sleeper(run));
      await container.start();

      // Act
      await container.start();
      await container.stop({ t: 0 });
      await container.stop({ t: 0 });
      await container.remove();
      await container.remove();

      // Assert
      assert.equal(await docker.containers.find(container.id), undefined);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('three concurrent force removals of one running container all resolve', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await docker.containers.create(sleeper(run));
      await container.start();

      // Act
      const removals = await Promise.allSettled([
        container.remove({ force: true, v: true }),
        container.remove({ force: true, v: true }),
        container.remove({ force: true, v: true }),
      ]);

      // Assert
      assert.deepEqual(
        removals.map((removal) => removal.status),
        ['fulfilled', 'fulfilled', 'fulfilled'],
        JSON.stringify(removals),
      );
      assert.equal(await docker.containers.find(container.id), undefined);
    } finally {
      await removeLabeled(docker, run);
    }
  });
});

describe('containers.createOrGet()', () => {
  test('eight concurrent calls with one name create one container, and each call gives its ID', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const name = `zukhruf-test-${run}`;
    try {
      // Act
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          docker.containers.createOrGet(sleeper(run), {
            name,
            signal: AbortSignal.timeout(30_000),
          }),
        ),
      );

      // Assert
      assert.equal(results.filter((result) => result.created).length, 1);
      assert.equal(
        new Set(results.map((result) => result.container.id)).size,
        1,
      );
      const listed = await docker.containers.list({
        all: true,
        filters: { label: [`${TEST_LABEL}=${run}`] },
      });
      assert.equal(listed.length, 1);
    } finally {
      await removeLabeled(docker, run);
    }
  });
});

describe('a create that the engine refuses', () => {
  test('a taken name is a NameConflictError with the taken name', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const name = `zukhruf-test-${run}`;
    try {
      await docker.containers.create(sleeper(run), { name });

      // Act
      const creating = docker.containers.create(sleeper(run), { name });

      // Assert
      await assert.rejects(creating, (error: unknown) => {
        assert.ok(error instanceof NameConflictError);
        assert.ok(error instanceof DockerEngineError);
        assert.equal(error.kind, 'container');
        assert.equal(error.takenName, name);
        assert.equal(error.name, 'NameConflictError');
        assert.equal(error.status, 409);
        return true;
      });
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('an image that is not on the engine is an ImageNotFoundError with the image', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const image = `zukhruf-missing-${run}:1`;
    try {
      // Act
      const creating = docker.containers.create({
        ...sleeper(run),
        Image: image,
      });

      // Assert
      await assert.rejects(creating, (error: unknown) => {
        assert.ok(error instanceof ImageNotFoundError);
        assert.equal(error.image, image);
        assert.equal(error.status, 404);
        return true;
      });
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('a bind mount whose source does not exist is a BindSourceNotFoundError with the path', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const source = `/zukhruf-missing-${run}`;
    try {
      // Act
      const creating = docker.containers.create({
        ...sleeper(run),
        HostConfig: {
          Mounts: [{ Type: 'bind', Source: source, Target: '/x' }],
        },
      });

      // Assert
      await assert.rejects(creating, (error: unknown) => {
        assert.ok(error instanceof BindSourceNotFoundError);
        assert.equal(error.source, source);
        return true;
      });
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('start() of a container on a network that does not exist is a NetworkNotFoundError with the network', async () => {
    // Arrange: the engine creates the container (201) and refuses the start.
    await using docker = await connect();
    const run = randomUUID();
    const network = `zukhruf-missing-${run}`;
    try {
      const container = await docker.containers.create({
        ...sleeper(run),
        HostConfig: { NetworkMode: network },
      });

      // Act
      const starting = container.start();

      // Assert
      await assert.rejects(starting, (error: unknown) => {
        assert.ok(error instanceof NetworkNotFoundError);
        assert.ok(!(error instanceof ContainerNotFoundError));
        assert.equal(error.network, network);
        return true;
      });
    } finally {
      await removeLabeled(docker, run);
    }
  });
});

describe('a request that the engine refuses for one container', () => {
  test('remove() without force of a running container is a ContainerRunningError and keeps the container', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await docker.containers.create(sleeper(run));
      await container.start();

      // Act
      const removing = container.remove({
        signal: AbortSignal.timeout(10_000),
      });

      // Assert
      await assert.rejects(removing, (error: unknown) => {
        assert.ok(error instanceof ContainerRunningError);
        assert.ok(error instanceof DockerEngineError);
        assert.equal(error.container, container.id);
        assert.equal(error.name, 'ContainerRunningError');
        assert.equal(error.status, 409);
        return true;
      });
      assert.equal((await container.inspect()).State?.Running, true);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('start() of a removed container is a ContainerNotFoundError with its ID', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await docker.containers.create(sleeper(run));
      await container.remove();

      // Act
      const starting = container.start();

      // Assert
      await assert.rejects(starting, (error: unknown) => {
        assert.ok(error instanceof ContainerNotFoundError);
        assert.equal(error.container, container.id);
        assert.equal(error.status, 404);
        return true;
      });
    } finally {
      await removeLabeled(docker, run);
    }
  });
});

describe('container.kill()', () => {
  test('a kill of a created container is a ContainerNotRunningError with the state created', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await docker.containers.create(sleeper(run));

      // Act
      const killing = container.kill();

      // Assert
      await assert.rejects(killing, (error: unknown) => {
        assert.ok(error instanceof ContainerNotRunningError);
        assert.equal(error.container, container.id);
        assert.equal(error.state, 'created');
        assert.equal(error.status, 409);
        return true;
      });
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('a container goes through pause, unpause, restart and kill, and wait() gives its exit code', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await docker.containers.create(sleeper(run));
      await container.start();

      // Act
      await container.pause();
      const paused = (await container.inspect()).State?.Status;
      await container.unpause();
      const startedBefore = (await container.inspect()).State?.StartedAt;
      await container.restart({ t: 0 });
      const restarted = (await container.inspect()).State;
      await container.kill('SIGKILL');
      const waited = await container.wait({ condition: 'not-running' });

      // Assert
      assert.equal(paused, 'paused');
      assert.equal(restarted?.Status, 'running');
      assert.notEqual(restarted?.StartedAt, startedBefore);
      assert.equal(waited.StatusCode, 137);
    } finally {
      await removeLabeled(docker, run);
    }
  });
});

describe('container.port()', () => {
  test('a published port gives its host and port, and an unpublished port gives undefined', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await docker.containers.create({
        ...sleeper(run),
        ExposedPorts: { '80/tcp': {}, '81/tcp': {} },
        HostConfig: {
          PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
        },
      });
      await container.start();

      // Act
      const published = await container.port(80);
      const unpublished = await container.port(81);
      const otherProtocol = await container.port(80, 'udp');

      // Assert
      assert.equal(published?.host, '127.0.0.1');
      assert.ok(Number.isInteger(published.port) && published.port > 0);
      assert.equal(unpublished, undefined);
      assert.equal(otherProtocol, undefined);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('a binding of each interface gives the IPv4 loopback address before the IPv6 one', async () => {
    // Arrange: the Ports of inspects of Docker Desktop for `-p 80` and
    // `-p '[::]::81'`, with the IPv6 binding of port 80 put first.
    await using scratch = await scratchDirectory();
    await using engine = await fakeEngine({
      directory: scratch.path,
      apiVersion: '1.51',
      answer: (request, response) => {
        if (request.url !== '/v1.51/containers/abc/json') {
          response.writeHead(404).end('{"message":"page not found"}');
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            Id: 'abc',
            NetworkSettings: {
              Ports: {
                '80/tcp': [
                  { HostIp: '::', HostPort: '59298' },
                  { HostIp: '0.0.0.0', HostPort: '59298' },
                ],
                '81/tcp': [{ HostIp: '::', HostPort: '59299' }],
                '82/tcp': null,
              },
            },
          }),
        );
      },
    });
    await using docker = await Docker.connect({ host: engine.host });
    const container = await docker.containers.find('abc');
    assert.ok(container);

    // Act
    const both = await container.port(80);
    const ipv6 = await container.port(81);
    const exposed = await container.port(82);

    // Assert
    assert.deepEqual(both, { host: '127.0.0.1', port: 59298 });
    assert.deepEqual(ipv6, { host: '::1', port: 59299 });
    assert.equal(exposed, undefined);
  });
});

describe('containers.list()', () => {
  test('a label filter gives only the containers with that label', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const other = randomUUID();
    try {
      const labeled = await docker.containers.create(sleeper(run));
      await docker.containers.create(sleeper(other));

      // Act
      const created = await docker.containers.list({
        all: true,
        filters: { label: [`${TEST_LABEL}=${run}`] },
      });
      const running = await docker.containers.list({
        filters: { label: [`${TEST_LABEL}=${run}`] },
      });

      // Assert
      assert.deepEqual(
        created.map((summary) => summary.Id),
        [labeled.id],
      );
      assert.deepEqual(running, []);
    } finally {
      await removeLabeled(docker, run);
      await removeLabeled(docker, other);
    }
  });
});
