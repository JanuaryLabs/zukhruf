import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { untilAborted } from '@zukhruf/async';
import { waitFor } from '@zukhruf/testing/async';

import { ConnectionSupervisor, PendingCalls, type Settler } from '../index.ts';
import { report, tag, threadConnector } from '../testing/threads.ts';
import { watch } from '../testing/watch.ts';

interface Request {
  id: string;
}

/** A thread that reports each message of the tests that it hears, and answers none. */
const recorder = `
	parentPort.on('message', (envelope) => {
		if (envelope !== null && typeof envelope === 'object' && ${JSON.stringify(tag)} in envelope)
			parentPort.postMessage({ heard: envelope[${JSON.stringify(tag)}] });
	});
`;

/** The calls of a supervisor over threads that record, wired as an owner wires them. */
function pendingOver(threads: ReturnType<typeof threadConnector<Request>>) {
  const link = new ConnectionSupervisor(threads.connector);
  const calls = new PendingCalls<Request, string>(link);
  link.on('connected', () => calls.resume());
  link.on('disconnected', () => calls.interrupt());
  return { link, calls };
}

/**
 * What `thread` heard on the open connection of `link`, in order, up to a
 * marker that the test sends last: a connection keeps the order of its
 * messages, so whatever went before the marker was heard before it.
 */
async function heardBy(
  link: ConnectionSupervisor<Request>,
  thread: NodeJS.EventEmitter,
  signal: AbortSignal,
) {
  const heard: unknown[] = [];
  const marked = Promise.withResolvers<void>();
  thread.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null) return;
    if (!('heard' in message)) return;
    if (isDeepStrictEqual(message.heard, { id: 'marker' })) marked.resolve();
    else heard.push(message.heard);
  });
  assert.ok(link.send({ id: 'marker' }), 'The marker must go out');
  await untilAborted(marked.promise, signal);
  return heard;
}

describe('A call that went out on a connection that was lost', () => {
  test("with 'resend' goes again, once, on the next connection", async (t) => {
    // Arrange: an acquire reached the first thread.
    await using threads = threadConnector<Request>(recorder);
    const { link, calls } = pendingOver(threads);
    const answer = watch(calls.add('a', { id: 'a' }, 'resend'));
    const first = threads.threads[0]!;
    assert.deepEqual(await report(first, t.signal), { heard: { id: 'a' } });

    try {
      // Act: the thread ends, and the supervisor starts the next one.
      const connected = once(link, 'connected');
      await first.terminate();
      await untilAborted(connected, t.signal);

      // Assert
      assert.deepEqual(await heardBy(link, threads.threads[1]!, t.signal), [
        { id: 'a' },
      ]);
      assert.equal(answer.now.status, 'pending');
    } finally {
      await link.close();
    }
  });

  test('with atLoss is given to it at the loss and never sent again, while a call made meanwhile goes once', async (t) => {
    // Arrange: a try reached the first thread.
    await using threads = threadConnector<Request>(recorder);
    const { link, calls } = pendingOver(threads);
    const lost: { status: string; call: Settler<string> }[] = [];
    const answer = calls.add(
      'try',
      { id: 'try' },
      { atLoss: (call) => lost.push({ status: link.status, call }) },
    );
    const first = threads.threads[0]!;
    assert.deepEqual(await report(first, t.signal), { heard: { id: 'try' } });

    try {
      // Act: the thread ends; a new call comes as the loss is heard, before the next thread is there.
      let queuedAt: string | undefined;
      const disconnected = Promise.withResolvers<void>();
      link.once('disconnected', () => {
        queuedAt = link.status;
        void calls.add('queued', { id: 'queued' }, 'resend');
        disconnected.resolve();
      });
      const connected = once(link, 'connected');
      await first.terminate();
      await untilAborted(disconnected.promise, t.signal);
      lost[0]?.call.resolve('busy');

      // Assert
      assert.deepEqual(
        lost.map(({ status }) => status),
        ['connecting'],
        'The policy must get the call once, at the loss',
      );
      assert.equal(
        queuedAt,
        'connecting',
        'The new call must wait for the next connection',
      );
      assert.equal(await untilAborted(answer, t.signal), 'busy');
      assert.equal(
        calls.take('try'),
        undefined,
        'The call must be out of the table',
      );
      await untilAborted(connected, t.signal);
      assert.deepEqual(await heardBy(link, threads.threads[1]!, t.signal), [
        { id: 'queued' },
      ]);
    } finally {
      await link.close();
    }
  });

  test('with atReconnect waits through the loss, is given to it when the next connection opens, and is never sent again', async (t) => {
    // Arrange: a try reached the first thread.
    await using threads = threadConnector<Request>(recorder);
    const { link, calls } = pendingOver(threads);
    const answer = watch(
      calls.add(
        'try',
        { id: 'try' },
        { atReconnect: (call) => call.resolve(`busy at ${link.status}`) },
      ),
    );
    const first = threads.threads[0]!;
    assert.deepEqual(await report(first, t.signal), { heard: { id: 'try' } });
    let atLoss: string | undefined;
    link.once('disconnected', () => {
      atLoss = answer.now.status;
    });

    try {
      // Act
      const connected = once(link, 'connected');
      await first.terminate();
      await untilAborted(connected, t.signal);

      // Assert
      assert.equal(atLoss, 'pending', 'The call must wait through the loss');
      await waitFor(() => assert.equal(answer.now.status, 'fulfilled'), {
        signal: t.signal,
      });
      assert.deepEqual(answer.now, {
        status: 'fulfilled',
        value: 'busy at connected',
      });
      assert.deepEqual(await heardBy(link, threads.threads[1]!, t.signal), []);
    } finally {
      await link.close();
    }
  });
});

describe('A call taken out of the table', () => {
  test('says whether it went out on the open connection, and is gone for a later answer', async (t) => {
    // Arrange: one call is made before the connection opens, one after.
    await using threads = threadConnector<Request>(recorder);
    const { link, calls } = pendingOver(threads);
    void calls.add('early', { id: 'early' }, 'resend');
    const early = calls.take('early');
    await untilAborted(once(link, 'connected'), t.signal);
    void calls.add('late', { id: 'late' }, 'resend');

    try {
      // Act
      const late = calls.take('late');

      // Assert
      assert.equal(
        early?.sent,
        false,
        'A call made before the connection opened did not go out',
      );
      assert.equal(
        late?.sent,
        true,
        'A call made on the open connection went out',
      );
      assert.equal(
        calls.take('late'),
        undefined,
        'A later answer must find nothing',
      );
    } finally {
      await link.close();
    }
  });
});
