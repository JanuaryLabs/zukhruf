import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';

import {
  ClientDisposedError,
  Docker,
  DockerEngineError,
  DockerError,
  type EngineApi,
} from './index.ts';
import { IMAGE, TEST_LABEL, connect, removeLabeled } from './testing/engine.ts';
import { fakeEngine } from './testing/fake-engine.ts';

/**
 * A fake engine whose GET /info gives `systemTime`, and whose GET /events
 * answers with `events`. Each other request gets 404.
 */
function eventsEngine(
  directory: string,
  events: (request: IncomingMessage, response: ServerResponse) => void,
  systemTime = '2026-11-27T11:28:31.197162Z',
) {
  return fakeEngine({
    directory,
    apiVersion: '1.51',
    answer: (request, response) => {
      if (request.method === 'GET' && request.url === '/v1.51/info') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ SystemTime: systemTime }));
        return;
      }
      if (
        request.method === 'GET' &&
        request.url?.startsWith('/v1.51/events?') === true
      ) {
        events(request, response);
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: 'page not found' }));
    },
  });
}

/** The headers of a stream of events, and no event. */
function quiet(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.flushHeaders();
}

/** One event as the engine writes it: a line of JSON. */
function line(event: EngineApi.EventMessage): string {
  return `${JSON.stringify(event)}\n`;
}

describe('docker.watch() ends the stream when the caller or the engine ends it', () => {
  test('an abort of the signal of watch() while no event comes rejects find() with the reason of the signal', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await using engine = await eventsEngine(scratch.path, quiet);
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const controller = new AbortController();
    const reason = new Error('the caller stopped waiting');
    const events = await docker.watch({ signal: controller.signal });
    try {
      // Act
      const found = events.find(() => true);
      controller.abort(reason);

      // Assert
      await assert.rejects(found, (error: unknown) => error === reason);
    } finally {
      events.destroy();
    }
  });

  test('a connection that the engine closes after its answer started destroys the stream with the error of Node, not with a DockerError', async () => {
    // Arrange: the engine writes one event, then resets the connection.
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await using engine = await eventsEngine(
      scratch.path,
      (request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write(line({ Type: 'container', Action: 'start' }), () =>
          request.socket.destroy(),
        );
      },
    );
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const events = await docker.watch();
    try {
      // Act
      const found = events.find(
        (event: EngineApi.EventMessage) => event.Action === 'die',
      );

      // Assert: the README gives this error for a lost connection (ADR 0011).
      await assert.rejects(found, (error: unknown) => {
        assert.ok(Error.isError(error));
        assert.equal(error instanceof DockerError, false);
        assert.equal(error.message, 'aborted');
        assert.equal(Reflect.get(error, 'code'), 'ECONNRESET');
        return true;
      });
    } finally {
      events.destroy();
    }
  });

  test('when the engine ends its answer, the stream ends and find() gives undefined', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await using engine = await eventsEngine(
      scratch.path,
      (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(line({ Type: 'container', Action: 'start' }));
      },
    );
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const events = await docker.watch();
    try {
      // Act
      const found = await events.find(
        (event: EngineApi.EventMessage) => event.Action === 'die',
      );

      // Assert
      assert.equal(found, undefined);
      assert.equal(events.readableEnded, true);
    } finally {
      events.destroy();
    }
  });
});

describe('docker.watch() starts at an instant of the engine clock', () => {
  test('without since, GET /events carries the SystemTime of GET /info as since, with its fraction and offset, and the filters of the caller', async () => {
    // Arrange: the engine clock is years away from the clock of this process.
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await using engine = await eventsEngine(
      scratch.path,
      (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write(
          line({ Type: 'container', Action: 'destroy', Actor: { ID: 'c1' } }),
        );
      },
      '2020-01-01T00:00:00.5+03:00',
    );
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const filters = { container: ['c1'], event: ['destroy'] };

    // Act
    const events = await docker.watch({ filters });
    try {
      const destroyed = await events.find(
        (event: EngineApi.EventMessage) => event.Action === 'destroy',
      );

      // Assert
      assert.equal(destroyed?.Actor?.ID, 'c1');
      assert.deepEqual(engine.paths, [
        '/_ping',
        '/v1.51/info',
        `/v1.51/events?${new URLSearchParams({ since: '1577826000.5', filters: JSON.stringify(filters) })}`,
      ]);
    } finally {
      events.destroy();
    }
  });

  test('with since, watch() reads no engine clock and sends the since of the caller', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await using engine = await eventsEngine(scratch.path, quiet);
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const filters = { label: ['dev.zukhruf.docker.test=run'] };

    // Act
    const events = await docker.watch({ since: 1700000000.25, filters });
    events.destroy();

    // Assert
    assert.deepEqual(engine.paths, [
      '/_ping',
      `/v1.51/events?${new URLSearchParams({ since: '1700000000.25', filters: JSON.stringify(filters) })}`,
    ]);
  });
});

describe('docker.watch() fails before the stream opens', () => {
  void test.each(
    [
      ['GET /info', '/v1.51/info'],
      ['GET /events', '/v1.51/events?'],
    ] as const,
    ([request, failing]) =>
      test(`a 500 of ${request} rejects watch() with DockerEngineError, with the message of the engine`, async () => {
        // Arrange
        await using scratch = await new TemporaryFiles().directory(
          'docker-test-',
        );
        await using engine = await fakeEngine({
          directory: scratch.path,
          apiVersion: '1.51',
          answer: (incoming, response) => {
            if (incoming.url?.startsWith(failing) === true) {
              response.writeHead(500, { 'Content-Type': 'application/json' });
              response.end(JSON.stringify({ message: 'the engine failed' }));
              return;
            }
            if (incoming.url === '/v1.51/info') {
              response.writeHead(200, { 'Content-Type': 'application/json' });
              response.end(
                JSON.stringify({ SystemTime: '2026-11-27T11:28:31.197162Z' }),
              );
              return;
            }
            response.writeHead(404, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ message: 'page not found' }));
          },
        });
        await using docker = await Docker.connect({
          clock: globalThis,
          host: engine.host,
        });

        // Act
        const watching = docker.watch();

        // Assert
        await assert.rejects(watching, (error: unknown) => {
          assert.ok(error instanceof DockerEngineError);
          assert.equal(error.status, 500);
          assert.equal(error.message, 'the engine failed');
          return true;
        });
      }),
  );

  test('a signal that is already aborted rejects watch() with its reason, and sends no request', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await using engine = await fakeEngine({
      directory: scratch.path,
      apiVersion: '1.51',
    });
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const reason = new Error('the caller stopped waiting');

    // Act
    const watching = docker.watch({ signal: AbortSignal.abort(reason) });

    // Assert
    await assert.rejects(watching, (error: unknown) => error === reason);
    assert.deepEqual(engine.paths, ['/_ping']);
  });

  test('an abort while the engine has not answered GET /events rejects watch() with its reason and closes the connection of the request', async () => {
    // Arrange: the engine never answers GET /events.
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    const eventsArrived = Promise.withResolvers<void>();
    const eventsClosed = Promise.withResolvers<void>();
    await using engine = await eventsEngine(scratch.path, (request) => {
      request.socket.once('close', () => eventsClosed.resolve());
      eventsArrived.resolve();
    });
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const controller = new AbortController();
    const reason = new Error('the caller stopped waiting');
    const watching = assert.rejects(
      docker.watch({ signal: controller.signal }),
      (error: unknown) => error === reason,
    );
    await eventsArrived.promise;

    // Act
    controller.abort(reason);

    // Assert
    await watching;
    await eventsClosed.promise;
  });
});

describe('docker.watch() gives one EventMessage for each line of the engine', () => {
  test('two events in one write, and an event split inside a UTF-8 character across two writes, come whole and in order', async () => {
    // Arrange: the engine writes the rest of the split event only after the
    // test read the events before it, so the two parts come in two chunks.
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    const rest = Promise.withResolvers<void>();
    await using engine = await eventsEngine(
      scratch.path,
      (_request, response) => {
        const split = Buffer.from(
          line({
            Type: 'container',
            Action: 'start',
            Actor: { Attributes: { name: 'café' } },
          }),
        );
        const cut = split.indexOf(0xc3) + 1;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write(
          Buffer.concat([
            Buffer.from(line({ Type: 'container', Action: 'create' })),
            Buffer.from(line({ Type: 'container', Action: 'attach' })),
            split.subarray(0, cut),
          ]),
        );
        void rest.promise.then(() => response.write(split.subarray(cut)));
      },
    );
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const events = await docker.watch();
    try {
      const reader = events.iterator({ destroyOnReturn: false });
      const created: IteratorResult<EngineApi.EventMessage> =
        await reader.next();
      const attached: IteratorResult<EngineApi.EventMessage> =
        await reader.next();

      // Act
      rest.resolve();
      const started: IteratorResult<EngineApi.EventMessage> =
        await reader.next();

      // Assert
      assert.equal(created.value?.Action, 'create');
      assert.equal(attached.value?.Action, 'attach');
      assert.equal(started.value?.Action, 'start');
      assert.equal(started.value?.Actor?.Attributes?.name, 'café');
    } finally {
      events.destroy();
    }
  });

  test('a last event with no newline before the end of the answer comes', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await using engine = await eventsEngine(
      scratch.path,
      (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ Type: 'container', Action: 'die' }));
      },
    );
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const events = await docker.watch();
    try {
      // Act
      const died = await events.find(
        (event: EngineApi.EventMessage) => event.Action === 'die',
      );

      // Assert
      assert.equal(died?.Action, 'die');
    } finally {
      events.destroy();
    }
  });

  test('a line of the engine that is not JSON destroys the stream with the SyntaxError', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await using engine = await eventsEngine(
      scratch.path,
      (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('the engine broke\n');
      },
    );
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const events = await docker.watch();
    try {
      // Act
      const found = events.find(() => true);

      // Assert
      await assert.rejects(found, SyntaxError);
    } finally {
      events.destroy();
    }
  });
});

describe('docker.watch() on the engine of the environment', () => {
  test('a container created right after watch() resolved gives the first create event, and one created before watch() does not', async (t) => {
    // Arrange: a container of the run that was created and removed before the stream.
    await using docker = await connect(IMAGE, t.signal);
    const run = randomUUID();
    const labels = { [TEST_LABEL]: run };
    try {
      const before = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['true'],
        Labels: labels,
      });
      await before.remove({ force: true });
      const events = await docker.watch({
        filters: { label: [`${TEST_LABEL}=${run}`], event: ['create'] },
        signal: t.signal,
      });
      try {
        // Act
        const after = await docker.containers.create({
          Image: IMAGE,
          Cmd: ['true'],
          Labels: labels,
        });
        const created = await events.find(
          (event: EngineApi.EventMessage) => event.Action === 'create',
        );

        // Assert
        assert.equal(created?.Actor?.ID, after.id);
      } finally {
        events.destroy();
      }
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('a since of the Created of a container gives its create event, which came before watch()', async (t) => {
    // Arrange
    await using docker = await connect(IMAGE, t.signal);
    const run = randomUUID();
    try {
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['true'],
        Labels: { [TEST_LABEL]: run },
      });
      const { Created } = await container.inspect();
      assert.ok(Created, 'the engine gives the Created of the container');

      // Act
      const events = await docker.watch({
        since: Date.parse(Created) / 1000,
        filters: { label: [`${TEST_LABEL}=${run}`], event: ['create'] },
        signal: t.signal,
      });
      try {
        const created = await events.find(
          (event: EngineApi.EventMessage) => event.Action === 'create',
        );

        // Assert
        assert.equal(created?.Actor?.ID, container.id);
      } finally {
        events.destroy();
      }
    } finally {
      await removeLabeled(docker, run);
    }
  });
});

describe('docker.watch() closes the connection of its stream', () => {
  test('a disposal of the client destroys an open stream with ClientDisposedError and closes its connection', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    const eventsClosed = Promise.withResolvers<void>();
    await using engine = await eventsEngine(
      scratch.path,
      (request, response) => {
        request.socket.once('close', () => eventsClosed.resolve());
        quiet(request, response);
      },
    );
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const events = await docker.watch();
    try {
      const found = assert.rejects(
        events.find(() => true),
        ClientDisposedError,
      );

      // Act
      await docker[Symbol.asyncDispose]();

      // Assert
      await found;
      await eventsClosed.promise;
    } finally {
      events.destroy();
    }
  });

  test('a destroy of the stream after find() gave its event closes the connection of the stream', async () => {
    // Arrange: the engine writes one event and keeps its answer open.
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    const eventsClosed = Promise.withResolvers<void>();
    await using engine = await eventsEngine(
      scratch.path,
      (request, response) => {
        request.socket.once('close', () => eventsClosed.resolve());
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write(line({ Type: 'container', Action: 'destroy' }));
      },
    );
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const events = await docker.watch();
    const found = await events.find(
      (event: EngineApi.EventMessage) => event.Action === 'destroy',
    );

    // Act: after its match, find() destroys the stream only at the next event.
    events.destroy();

    // Assert
    assert.equal(found?.Action, 'destroy');
    await eventsClosed.promise;
  });

  test('a destroy of the stream while no event comes closes the connection of the stream', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    const eventsClosed = Promise.withResolvers<void>();
    await using engine = await eventsEngine(
      scratch.path,
      (request, response) => {
        request.socket.once('close', () => eventsClosed.resolve());
        quiet(request, response);
      },
    );
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const events = await docker.watch();
    const found = events.find(() => true);

    // Act
    events.destroy();

    // Assert
    await assert.rejects(found, { code: 'ERR_STREAM_PREMATURE_CLOSE' });
    await eventsClosed.promise;
  });
});
