import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, test } from 'node:test';

import { untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { PipeEndpoint } from '@zukhruf/pipes';
import { NodeCommand } from '@zukhruf/process';

import { flightElection } from './connection/flight-election.ts';
import { SingleFlight } from './index.ts';
import { isRecord } from './shared/is-record.ts';
import { standInServer } from './testing/stand-in-server.ts';

const indexUrl = new URL('./index.ts', import.meta.url);

/**
 * A process that runs `steps` with one `SingleFlight` on `directory`. It
 * listens to no message of the test, so only its single flight can keep it
 * alive.
 */
function followerProcess(directory: string, steps: string) {
  return new NodeCommand(
    `
      import { SingleFlight } from ${JSON.stringify(indexUrl.href)};
      const flights = new SingleFlight({
        clock: globalThis,
        directory: ${JSON.stringify(directory)},
        codec: { encode: (value) => value, decode: (text) => text },
      });
      ${steps}
    `,
    { name: 'follower', env: process.env, clock: globalThis },
  ).start();
}

/** This process coordinates the single flights on `directory`: its first run wins the term. The run leads `key` until the test lands it. */
async function coordinatorLeading(directory: string, key: string) {
  const coordinator = new SingleFlight<string>({
    clock: globalThis,
    directory,
    codec: { encode: (value) => value, decode: (text) => text },
  });
  const leading = Promise.withResolvers<void>();
  const landing = Promise.withResolvers<string>();
  const led = coordinator.run(key, async () => {
    leading.resolve();
    return landing.promise;
  });
  await leading.promise;
  return {
    land: async (value: string) => {
      landing.resolve(value);
      await led;
    },
    [Symbol.asyncDispose]: () => coordinator[Symbol.asyncDispose](),
  };
}

describe('A follower process of a single flight', () => {
  test('a follower process whose run joined a flight exits by itself once it got the value', async (t) => {
    // Arrange: the follower joins the flight that this process leads.
    await using directory = await new TemporaryFiles().directory('flights-');
    await using coordinator = await coordinatorLeading(
      directory.path,
      'report',
    );
    await using follower = await followerProcess(
      directory.path,
      `
        const answer = await flights.run('report', async () => 'never', {
          onJoin: () => process.send({ type: 'joined' }),
        });
        process.send({ type: 'answered', answer });
      `,
    );
    await follower.next('joined', { signal: t.signal });

    // Act: the flight lands, and the follower has nothing else to do.
    await untilAborted(coordinator.land('quarterly'), t.signal);

    // Assert
    const end = await untilAborted(follower.process.ended, t.signal);
    assert.deepEqual(end, { exitCode: 0 }, follower.process.stderrTail());
    assert.deepEqual(
      follower.messages.find((message) => message.type === 'answered')?.answer,
      {
        value: 'quarterly',
        joined: true,
      },
    );
  });

  // A new single flight keeps its process alive until its first run ends, so
  // only a run after that shows what keeps a process alive while it waits.
  test("a follower process whose run waits for another process's flight stays alive until the flight lands, also after its own flight was acknowledged, and then exits by itself", async (t) => {
    // Arrange: the follower leads a flight of its own, which the coordinator acknowledges, and then joins the flight that this process leads.
    await using directory = await new TemporaryFiles().directory('flights-');
    await using coordinator = await coordinatorLeading(
      directory.path,
      'report',
    );
    await using follower = await followerProcess(
      directory.path,
      `
        await flights.run('export', async () => 'exported');
        const answer = await flights.run('report', async () => 'never', {
          onJoin: () => {
            // A timer that keeps no process alive runs only in a process that something else keeps alive.
            setTimeout(() => process.send({ type: 'alive' }), 0).unref();
          },
        });
        process.send({ type: 'answered', answer });
      `,
    );
    // A follower that exits while its run waits closes before it sends 'alive', and next() rejects with its exit.
    await follower.next('alive', { signal: t.signal });

    // Act: the flight lands.
    await untilAborted(coordinator.land('quarterly'), t.signal);

    // Assert
    const end = await untilAborted(follower.process.ended, t.signal);
    assert.deepEqual(end, { exitCode: 0 }, follower.process.stderrTail());
    assert.deepEqual(
      follower.messages.find((message) => message.type === 'answered')?.answer,
      {
        value: 'quarterly',
        joined: true,
      },
    );
  });

  test('a follower process that led a flight stays alive until the coordinator acknowledges its landing, and then exits by itself', async (t) => {
    // Arrange: this process holds the coordinator's term and answers on its
    // socket by hand, because a coordinator of this package acknowledges a
    // landing at once. It tells each run to lead, and keeps the landing.
    await using directory = await new TemporaryFiles().directory('flights-');
    await using term = await flightElection(
      directory.path,
      globalThis,
    ).campaign();
    assert.ok(term, 'The first campaign in an empty directory must win');
    const landed = Promise.withResolvers<{ peer: Socket; id: unknown }>();
    const { path } = new PipeEndpoint(resolve(directory.path, 'flight.sock'), {
      prefix: 'zukhruf-single-flight',
    }).address;
    await using _coordinator = await standInServer(path, (peer) => {
      // readline emits the socket's errors again, e.g. a reset on Linux when the client closes with unread data.
      const lines = createInterface({ input: peer }).on('error', () => {});
      lines.on('line', (line) => {
        const request: unknown = JSON.parse(line);
        if (!isRecord(request)) return;
        const { op, id } = request;
        if (op === 'hello') peer.write('{"op":"welcome"}\n');
        if (op === 'run') {
          const token = String((term.epoch << 32n) | 1n);
          peer.write(`${JSON.stringify({ op: 'lead', id, token })}\n`);
        }
        if (op === 'land') landed.resolve({ peer, id });
      });
    });
    await using follower = await followerProcess(
      directory.path,
      `
        const answer = await flights.run('export', async () => 'exported');
        // A timer that keeps no process alive runs only in a process that something else keeps alive.
        // It also sends the answer, so no write to the test is pending that would keep the process alive in its place.
        setTimeout(() => process.send({ type: 'alive', answer }), 0).unref();
      `,
    );
    const landing = await untilAborted(landed.promise, t.signal);
    // A follower that exits while its landing waits closes before it sends 'alive', and next() rejects with its exit.
    const alive = await follower.next('alive', { signal: t.signal });

    // Act: the coordinator acknowledges the landing.
    landing.peer.write(`${JSON.stringify({ op: 'ack', id: landing.id })}\n`);

    // Assert
    const end = await untilAborted(follower.process.ended, t.signal);
    assert.deepEqual(end, { exitCode: 0 }, follower.process.stderrTail());
    assert.deepEqual(alive.answer, {
      value: 'exported',
      joined: false,
    });
  });
});
