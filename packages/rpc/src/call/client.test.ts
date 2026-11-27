import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, test } from 'node:test';

import { untilAborted } from '@zukhruf/async';

import {
  ChildProcessConnection,
  Client,
  ConnectionLostError,
  ConnectionSupervisor,
  ErrorCodec,
  type RpcMessage,
  Server,
} from '../index.ts';
import {
  linkTo,
  report,
  serving,
  startAsker,
  tag,
  threadConnector,
} from '../testing/threads.ts';

const isVoid = (answer: unknown): answer is void => answer === undefined;
const isString = (answer: unknown): answer is string =>
  typeof answer === 'string';
/** How many pipes keep a process alive, in a list of `process.getActiveResourcesInfo()`. */
const pipes = (resources: unknown) =>
  Array.isArray(resources)
    ? resources.filter((resource) => resource === 'PipeWrap').length
    : Number.NaN;
const noParams = (params: readonly unknown[]): params is [] =>
  params.length === 0;

describe('A call whose connection is lost', () => {
  test('rejects with ConnectionLostError as soon as the thread exits, before a new thread is there', async (t) => {
    // Arrange: a thread whose method ends the thread; no second thread ever comes.
    await using threads = threadConnector<RpcMessage>(
      serving(
        `{ exit: () => process.exit(0) }`,
        `{ exit: (p) => p.length === 0 }`,
      ),
      1,
    );
    const link = new ConnectionSupervisor(threads.connector);
    await using client = new Client<{ exit(): void }>(link, {
      errors: new ErrorCodec([]),
      answers: { exit: isVoid },
    });

    // Act
    const call = client.call('exit', []);

    // Assert
    await assert.rejects(untilAborted(call, t.signal), ConnectionLostError);
    assert.equal(
      link.status,
      'connecting',
      'The call must reject while no thread is there to answer it',
    );
  });

  test('rejects with ConnectionLostError when the connector has no peer left to connect to', async (t) => {
    // Arrange: a connector that finds no peer, so the supervisor becomes unavailable.
    const link = new ConnectionSupervisor<RpcMessage>({
      connect: async () => undefined,
    });
    await using client = new Client<{ ping(): string }>(link, {
      errors: new ErrorCodec([]),
      answers: { ping: isString },
    });
    const unavailable = once(link, 'unavailable');

    // Act
    const rejected = assert.rejects(
      untilAborted(client.call('ping', []), t.signal),
      ConnectionLostError,
    );

    // Assert
    await untilAborted(unavailable, t.signal);
    await rejected;
  });

  test('is not sent again on the next connection, and a later call is answered by the new thread', async (t) => {
    // Arrange: each thread's `exit` ends that thread, and `ping` answers.
    await using threads = threadConnector<RpcMessage>(
      serving(
        `{ exit: () => process.exit(0), ping: () => 'pong' }`,
        `{ exit: (p) => p.length === 0, ping: (p) => p.length === 0 }`,
      ),
    );
    await using client = new Client<{ exit(): void; ping(): string }>(
      new ConnectionSupervisor(threads.connector),
      { errors: new ErrorCodec([]), answers: { exit: isVoid, ping: isString } },
    );
    await assert.rejects(
      untilAborted(client.call('exit', []), t.signal),
      ConnectionLostError,
    );

    // Act
    const answer = await untilAborted(client.call('ping', []), t.signal);

    // Assert: an `exit` sent again would have ended the second thread too.
    assert.equal(answer, 'pong');
    assert.equal(threads.threads.length, 2, 'Only one thread must have ended');
  });
});

describe('A call that waits', () => {
  test('keeps its process alive until its answer, and the process exits by itself once no call waits', async (t) => {
    // Arrange: a process asks twice, and reports what keeps it alive after the first answer and while the second call waits.
    // Its IPC channel is listed as one more `PipeWrap`, beside its stderr pipe, only while the channel is ref'd; a small `process.send` of its own adds none.
    await using asker = startAsker(
      `
				await client.call('ping', []);
				const idle = process.getActiveResourcesInfo();
				const second = client.call('ping', []);
				process.send({ type: 'waiting', idle, waiting: process.getActiveResourcesInfo() });
				process.send({ type: 'answer', answer: await second });
			`,
      `{ ping: (answer) => typeof answer === 'string' }`,
    );
    const second = Promise.withResolvers<string>();
    let pings = 0;
    new Server(
      { ping: () => (++pings === 1 ? 'first' : second.promise) },
      { methods: { ping: noParams }, errors: new ErrorCodec([]) },
    ).serve(linkTo(new ChildProcessConnection(asker.child, { tag })));
    const reported = await asker.next('waiting', { signal: t.signal });

    // Act
    second.resolve('pong');

    // Assert
    assert.equal(
      pipes(reported.waiting) - pipes(reported.idle),
      1,
      'A call that waits must keep its process alive through its channel',
    );
    assert.equal(
      (await asker.next('answer', { signal: t.signal })).answer,
      'pong',
    );
    await untilAborted(asker.closed, t.signal);
    assert.deepEqual(asker.exit, { code: 0, signal: null }, asker.stderr);
  });

  test('whose signal aborts rejects with the reason, and no longer keeps its process alive although no answer came', async (t) => {
    // Arrange: this process never answers; the asker stops waiting after 50 ms.
    await using asker = startAsker(
      `
				const reason = await client.call('hang', [], { signal: AbortSignal.timeout(50) }).catch((error) => error.name);
				process.send({ type: 'reason', reason });
			`,
      `{ hang: (answer) => answer === undefined }`,
    );
    new Server(
      { hang: () => new Promise<void>(() => {}) },
      { methods: { hang: noParams }, errors: new ErrorCodec([]) },
    ).serve(linkTo(new ChildProcessConnection(asker.child, { tag })));

    // Act
    const reported = await asker.next('reason', { signal: t.signal });

    // Assert
    assert.equal(reported.reason, 'TimeoutError');
    await untilAborted(asker.closed, t.signal);
    assert.deepEqual(asker.exit, { code: 0, signal: null }, asker.stderr);
  });
});

describe('An answer', () => {
  test('that its check refuses rejects the call with a TypeError', async (t) => {
    // Arrange: the thread answers a number where the client expects a string.
    await using threads = threadConnector<RpcMessage>(
      serving(`{ name: () => 42 }`, `{ name: (p) => p.length === 0 }`),
    );
    await using client = new Client<{ name(): string }>(
      new ConnectionSupervisor(threads.connector),
      { errors: new ErrorCodec([]), answers: { name: isString } },
    );

    // Act
    const call = client.call('name', []);

    // Assert
    await assert.rejects(untilAborted(call, t.signal), TypeError);
  });
});

describe('A notification', () => {
  test('made before the connection opens goes once it opens', async (t) => {
    // Arrange: the thread reports each notification it runs.
    await using threads = threadConnector<RpcMessage>(
      serving(
        `{ record: (word) => parentPort.postMessage({ recorded: word }) }`,
        `{ record: (p) => p.length === 1 && typeof p[0] === 'string' }`,
      ),
    );
    await using client = new Client<{ record(word: string): void }>(
      new ConnectionSupervisor(threads.connector),
      { errors: new ErrorCodec([]), answers: { record: isVoid } },
    );

    // Act
    client.notify('record', ['first']);

    // Assert
    const thread = threads.threads[0];
    assert.ok(thread, 'The notification must open the connection');
    assert.deepEqual(await report(thread, t.signal), { recorded: 'first' });
  });

  test('made before the connection opens, and one made as it opens, arrive in the order they were made', async (t) => {
    // Arrange: the thread reports each notification it runs; a host hears of the connection before the client does, and notifies then.
    await using threads = threadConnector<RpcMessage>(
      serving(
        `{ record: (word) => parentPort.postMessage({ recorded: word }) }`,
        `{ record: (p) => p.length === 1 && typeof p[0] === 'string' }`,
      ),
    );
    const link = new ConnectionSupervisor(threads.connector);
    link.on('connected', () => client.notify('record', ['third']));
    await using client = new Client<{ record(word: string): void }>(link, {
      errors: new ErrorCodec([]),
      answers: { record: isVoid },
    });

    // Act
    client.notify('record', ['first']);
    client.notify('record', ['second']);

    // Assert
    const thread = threads.threads[0];
    assert.ok(thread, 'The notifications must open the connection');
    const recorded: unknown[] = [];
    const all = Promise.withResolvers<void>();
    thread.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      if (!('recorded' in message)) return;
      if (recorded.push(message) === 3) all.resolve();
    });
    await untilAborted(all.promise, t.signal);
    assert.deepEqual(recorded, [
      { recorded: 'first' },
      { recorded: 'second' },
      { recorded: 'third' },
    ]);
  });

  test('queued before the connection opens lets its process exit by itself once it went out', async (t) => {
    // Arrange: a process whose only work is one notification, made before its connection opens.
    await using asker = startAsker(
      `client.notify('record', ['went']);`,
      `{ record: (answer) => answer === undefined }`,
    );
    const recorded = Promise.withResolvers<string>();
    new Server(
      { record: (word: string) => recorded.resolve(word) },
      {
        methods: {
          record: (params): params is [string] =>
            params.length === 1 && typeof params[0] === 'string',
        },
        errors: new ErrorCodec([]),
      },
    ).serve(linkTo(new ChildProcessConnection(asker.child, { tag })));

    // Act
    const word = await untilAborted(recorded.promise, t.signal);

    // Assert
    assert.equal(word, 'went');
    await untilAborted(asker.closed, t.signal);
    assert.deepEqual(asker.exit, { code: 0, signal: null }, asker.stderr);
  });
});

describe('A client that ends', () => {
  test('rejects a call that waits, and each later call, with ConnectionLostError when it is disposed', async (t) => {
    // Arrange: the thread never answers `hang`.
    await using threads = threadConnector<RpcMessage>(
      serving(
        `{ hang: () => new Promise(() => {}) }`,
        `{ hang: (p) => p.length === 0 }`,
      ),
    );
    const client = new Client<{ hang(): void }>(
      new ConnectionSupervisor(threads.connector),
      { errors: new ErrorCodec([]), answers: { hang: isVoid } },
    );
    const waiting = client.call('hang', []);

    // Act
    await client[Symbol.asyncDispose]();

    // Assert
    await assert.rejects(untilAborted(waiting, t.signal), ConnectionLostError);
    await assert.rejects(client.call('hang', []), ConnectionLostError);
  });

  test('rejects a call that waits with the error of a connect that failed', async (t) => {
    // Arrange
    const refused = new Error('EACCES');
    await using client = new Client<{ ping(): string }>(
      new ConnectionSupervisor<RpcMessage>({
        connect: () => Promise.reject(refused),
      }),
      { errors: new ErrorCodec([]), answers: { ping: isString } },
    );

    // Act
    const call = client.call('ping', []);

    // Assert
    await assert.rejects(
      untilAborted(call, t.signal),
      (error) => error === refused,
    );
  });
});
