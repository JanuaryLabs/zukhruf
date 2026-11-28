import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { describe, test } from 'node:test';

import { untilAborted } from '@zukhruf/async';
import { NodeCommand } from '@zukhruf/process';

import {
  ChildProcessConnection,
  Client,
  type ConnectionSupervisor,
  ErrorCodec,
  Server,
  ServerWarning,
  WorkerConnection,
} from '../index.ts';
import {
  linkTo,
  report,
  startAsker,
  startThread,
  tag,
} from '../testing/threads.ts';

const rpcUrl = new URL('../index.ts', import.meta.url);
const isString = (answer: unknown): answer is string =>
  typeof answer === 'string';
const isVoid = (answer: unknown): answer is void => answer === undefined;
const noParams = (params: readonly unknown[]): params is [] =>
  params.length === 0;

describe('A server', () => {
  test('refuses a method of its target that it does not list, and does not run it', async (t) => {
    // Arrange: the target has `secret`, but the server lists only `ping`.
    let ran = false;
    await using asker = await startAsker(
      `
				const secret = await client.call('secret', []).then(() => 'answered', (error) => error.name);
				process.send({ type: 'secret', secret });
			`,
      `{ secret: (answer) => answer === undefined }`,
      {
        admit: (child) =>
          new Server(
            {
              secret: () => {
                ran = true;
              },
              ping: () => 'pong',
            },
            { methods: { ping: noParams }, errors: new ErrorCodec([]) },
          ).serve(linkTo(new ChildProcessConnection(child, { tag }))),
        signal: t.signal,
      },
    );

    // Act
    const reported = await asker.next('secret', { signal: t.signal });

    // Assert
    assert.equal(reported.secret, 'TypeError');
    assert.equal(
      ran,
      false,
      'A method that the server does not list must not run',
    );
  });

  test('refuses parameters that fail the check of the method, and does not run it', async (t) => {
    // Arrange: `add` takes two numbers; the asker sends two strings.
    let calls = 0;
    await using asker = await startAsker(
      `
				const sum = await client.call('add', ['1', '2']).then(String, (error) => error.name);
				process.send({ type: 'sum', sum });
			`,
      `{ add: (answer) => typeof answer === 'number' }`,
      {
        admit: (child) =>
          new Server(
            {
              add: (a: number, b: number) => {
                calls++;
                return a + b;
              },
            },
            {
              methods: {
                add: (params): params is [number, number] =>
                  params.length === 2 &&
                  params.every((term) => typeof term === 'number'),
              },
              errors: new ErrorCodec([]),
            },
          ).serve(linkTo(new ChildProcessConnection(child, { tag }))),
        signal: t.signal,
      },
    );

    // Act
    const reported = await asker.next('sum', { signal: t.signal });

    // Assert
    assert.equal(reported.sum, 'TypeError');
    assert.equal(
      calls,
      0,
      'A method whose parameters fail the check must not run',
    );
  });

  test("warns with ServerWarning when a notification's method throws, and answers the next call", async (t) => {
    // Arrange: the thread notifies a method that throws, then calls `ping`.
    const warnings: unknown[] = [];
    const onWarning = (warning: unknown) => warnings.push(warning);
    process.on('warning', onWarning);
    try {
      await using thread = startThread(`
				const port = new rpc.ParentPortConnection(parentPort, { tag: ${JSON.stringify(tag)} });
				const client = new rpc.Client(new rpc.ConnectionSupervisor({ connect: async () => port }), {
					errors: new rpc.ErrorCodec([]),
					answers: { fail: (answer) => answer === undefined, ping: (answer) => answer === 'pong' },
				});
				client.notify('fail', []);
				parentPort.postMessage({ answer: await client.call('ping', []) });
			`);
      new Server(
        {
          fail: (): void => {
            throw new Error('the disk is full');
          },
          ping: () => 'pong',
        },
        {
          methods: { fail: noParams, ping: noParams },
          errors: new ErrorCodec([]),
        },
      ).serve(linkTo(new WorkerConnection(thread, { tag })));

      // Act
      const reported = await report(thread, t.signal);

      // Assert
      assert.deepEqual(reported, { answer: 'pong' });
      const [warning] = warnings;
      assert.ok(warning instanceof ServerWarning, String(warning));
      assert.equal(warning.code, 'ZUKHRUF_RPC_NOTIFICATION_FAILED');
      assert.equal(warning.detail, 'method: fail');
      assert.ok(Error.isError(warning.cause));
      assert.equal(warning.cause.message, 'the disk is full');
    } finally {
      process.off('warning', onWarning);
    }
  });

  test("ignores the application's messages and other tags' on the same port, and answers the calls in its own envelope", async (t) => {
    // Arrange: before its call, the thread sends calls outside the envelope, in another tag's, and broken ones inside it, one of them a call whose only fault is its numeric id.
    let pings = 0;
    await using thread = startThread(`
			const call = { id: 'x', method: 'ping', params: [] };
			parentPort.postMessage(call);
			parentPort.postMessage({ '@other': call });
			parentPort.postMessage({ ${JSON.stringify(tag)}: 42 });
			parentPort.postMessage({ ${JSON.stringify(tag)}: { id: 'y', method: 'ping' } });
			parentPort.postMessage({ ${JSON.stringify(tag)}: { id: 7, method: 'ping', params: [] } });
			const port = new rpc.ParentPortConnection(parentPort, { tag: ${JSON.stringify(tag)} });
			const client = new rpc.Client(new rpc.ConnectionSupervisor({ connect: async () => port }), {
				errors: new rpc.ErrorCodec([]),
				answers: { ping: (answer) => typeof answer === 'number' },
			});
			parentPort.postMessage({ pings: await client.call('ping', []) });
		`);
    new Server(
      { ping: () => ++pings },
      { methods: { ping: noParams }, errors: new ErrorCodec([]) },
    ).serve(linkTo(new WorkerConnection(thread, { tag })));

    // Act
    const reported = await (async () => {
      for (;;) {
        const message = await report(thread, t.signal);
        if ('pings' in message) return message;
      }
    })();

    // Assert
    assert.deepEqual(reported, { pings: 1 });
  });
});

describe('A thread that serves', () => {
  test("answers its parent's next call after the last call of a client on the same link", async (t) => {
    // Arrange: the thread serves `ping` and asks `add` through one link; this process does both on its end.
    await using thread = startThread(`
			const connection = new rpc.ParentPortConnection(parentPort, { tag: ${JSON.stringify(tag)} });
			const link = new rpc.ConnectionSupervisor({ connect: async () => connection });
			new rpc.Server({ ping: () => 'pong' }, { methods: { ping: (p) => p.length === 0 }, errors: new rpc.ErrorCodec([]) }).serve(link);
			const client = new rpc.Client(link, {
				errors: new rpc.ErrorCodec([]),
				answers: { add: (answer) => typeof answer === 'number' },
			});
			parentPort.postMessage({ sum: await client.call('add', [1, 2]) });
		`);
    const link = linkTo(new WorkerConnection(thread, { tag }));
    new Server(
      { add: (a: number, b: number) => a + b },
      {
        methods: {
          add: (params): params is [number, number] =>
            params.length === 2 &&
            params.every((param) => typeof param === 'number'),
        },
        errors: new ErrorCodec([]),
      },
    ).serve(link);
    await using client = new Client<{ ping(): string }>(link, {
      errors: new ErrorCodec([]),
      answers: { ping: isString },
    });
    // The thread's client got its answer, so it holds the link no longer.
    assert.deepEqual(await report(thread, t.signal), { sum: 3 });

    // Act
    const answer = await untilAborted(client.call('ping', []), t.signal);

    // Assert: a thread that stopped listening would have exited, and the call would have been lost with it.
    assert.equal(answer, 'pong');
  });

  test('stays alive to answer while it serves, and exits by itself once it closes its link', async (t) => {
    // Arrange: the thread only serves; its `close` closes its link after the answer goes, and reports what still listens on its port.
    await using thread = startThread(`
			const connection = new rpc.ParentPortConnection(parentPort, { tag: ${JSON.stringify(tag)} });
			const link = new rpc.ConnectionSupervisor({ connect: async () => connection });
			const close = () => {
				setImmediate(async () => {
					await link.close();
					parentPort.postMessage({ listeners: parentPort.listenerCount('message') });
				});
			};
			new rpc.Server(
				{ ping: () => 'pong', close },
				{ methods: { ping: (p) => p.length === 0, close: (p) => p.length === 0 }, errors: new rpc.ErrorCodec([]) },
			).serve(link);
		`);
    const exited = once(thread, 'exit');
    await using client = new Client<{ ping(): string; close(): void }>(
      linkTo(new WorkerConnection(thread, { tag })),
      {
        errors: new ErrorCodec([]),
        answers: { ping: isString, close: isVoid },
      },
    );
    // A thread that does not hold its link exits before the call comes, and the call is lost with it.
    assert.equal(await untilAborted(client.call('ping', []), t.signal), 'pong');

    // Act
    await untilAborted(client.call('close', []), t.signal);

    // Assert: nothing listens on the port any more, so the thread ends by itself.
    assert.deepEqual(await report(thread, t.signal), { listeners: 0 });
    assert.deepEqual(await untilAborted(exited, t.signal), [0]);
  });
});

describe('A process that serves over its IPC channel', () => {
  test("answers its parent's next call after the last call of a client on the same link", async (t) => {
    // Arrange: the process serves `ping` and asks `add` through one link; this process does both on its end.
    const served = Promise.withResolvers<ConnectionSupervisor<unknown>>();
    await using peer = await new NodeCommand(
      `
				import { promisify } from 'node:util';
				import * as rpc from ${JSON.stringify(rpcUrl.href)};
				const channel = new rpc.ProcessChannelConnection(promisify(process.send).bind(process), { tag: ${JSON.stringify(tag)} });
				const link = new rpc.ConnectionSupervisor({ connect: async () => channel });
				new rpc.Server({ ping: () => 'pong' }, { methods: { ping: (p) => p.length === 0 }, errors: new rpc.ErrorCodec([]) }).serve(link);
				const client = new rpc.Client(link, {
					errors: new rpc.ErrorCodec([]),
					answers: { add: (answer) => typeof answer === 'number' },
				});
				process.send({ type: 'sum', sum: await client.call('add', [1, 2]) });
			`,
      { name: 'peer', env: process.env, clock: globalThis },
    ).start({
      admit: (child) => {
        const link = linkTo(new ChildProcessConnection(child, { tag }));
        new Server(
          { add: (a: number, b: number) => a + b },
          {
            methods: {
              add: (params): params is [number, number] =>
                params.length === 2 &&
                params.every((param) => typeof param === 'number'),
            },
            errors: new ErrorCodec([]),
          },
        ).serve(link);
        served.resolve(link);
      },
      signal: t.signal,
    });
    await using client = new Client<{ ping(): string }>(await served.promise, {
      errors: new ErrorCodec([]),
      answers: { ping: isString },
    });
    // The process's client got its answer, so it holds the link no longer.
    assert.equal((await peer.next('sum', { signal: t.signal })).sum, 3);

    // Act
    const answer = await untilAborted(client.call('ping', []), t.signal);

    // Assert: a process that stopped listening would have exited, and the call would have been lost with it.
    assert.equal(answer, 'pong');
  });

  test('stays alive to answer while it serves, and exits by itself once it closes its link', async (t) => {
    // Arrange: the process only serves; its `close` closes its link after the answer goes, and reports what still listens on its channel.
    const admitted = Promise.withResolvers<ChildProcess>();
    await using peer = await new NodeCommand(
      `
				import { promisify } from 'node:util';
				import * as rpc from ${JSON.stringify(rpcUrl.href)};
				const channel = new rpc.ProcessChannelConnection(promisify(process.send).bind(process), { tag: ${JSON.stringify(tag)} });
				const link = new rpc.ConnectionSupervisor({ connect: async () => channel });
				const close = () => {
					setImmediate(async () => {
						await link.close();
						process.send({ type: 'closed', listeners: process.listenerCount('message') });
					});
				};
				new rpc.Server(
					{ ping: () => 'pong', close },
					{ methods: { ping: (p) => p.length === 0, close: (p) => p.length === 0 }, errors: new rpc.ErrorCodec([]) },
				).serve(link);
			`,
      { name: 'peer', env: process.env, clock: globalThis },
    ).start({ admit: admitted.resolve, signal: t.signal });
    await using client = new Client<{ ping(): string; close(): void }>(
      linkTo(new ChildProcessConnection(await admitted.promise, { tag })),
      {
        errors: new ErrorCodec([]),
        answers: { ping: isString, close: isVoid },
      },
    );
    // A process that does not hold its link exits before the call comes, and the call is lost with it.
    assert.equal(await untilAborted(client.call('ping', []), t.signal), 'pong');

    // Act
    await untilAborted(client.call('close', []), t.signal);

    // Assert: nothing listens on the channel any more, so the process ends by itself.
    assert.equal(
      (await peer.next('closed', { signal: t.signal })).listeners,
      0,
    );
    assert.deepEqual(
      await untilAborted(peer.process.ended, t.signal),
      { exitCode: 0 },
      peer.process.stderrTail(),
    );
  });

  test("drops an answer whose caller's link is gone, and answers a call on a new link", async (t) => {
    // Arrange: `late` answers only once the process's channel to this process is gone; then the process calls `ping` of the same server over a port of its own.
    const admitted = Promise.withResolvers<ChildProcess>();
    await using peer = await new NodeCommand(
      `
				import { once } from 'node:events';
				import { promisify } from 'node:util';
				import { MessageChannel } from 'node:worker_threads';
				import * as rpc from ${JSON.stringify(rpcUrl.href)};
				const tag = ${JSON.stringify(tag)};
				const channel = new rpc.ProcessChannelConnection(promisify(process.send).bind(process), { tag });
				let given = false;
				const link = new rpc.ConnectionSupervisor({ connect: async () => (given ? undefined : ((given = true), channel)) });
				const gone = once(process, 'disconnect');
				const server = new rpc.Server(
					{
						late: async () => {
							process.send({ type: 'called' });
							await gone;
							return 'late';
						},
						ping: () => 'pong',
					},
					{ methods: { late: (p) => p.length === 0, ping: (p) => p.length === 0 }, errors: new rpc.ErrorCodec([]) },
				);
				server.serve(link);
				await gone;
				const { port1, port2 } = new MessageChannel();
				const served = new rpc.ConnectionSupervisor({ connect: async () => new rpc.ParentPortConnection(port1, { tag }) });
				server.serve(served);
				const client = new rpc.Client(new rpc.ConnectionSupervisor({ connect: async () => new rpc.ParentPortConnection(port2, { tag }) }), {
					errors: new rpc.ErrorCodec([]),
					answers: { ping: (answer) => answer === 'pong' },
				});
				console.error('answer: ' + (await client.call('ping', [])));
				await client[Symbol.asyncDispose]();
				await served.close();
				port1.close();
			`,
      { name: 'peer', env: process.env, clock: globalThis },
    ).start({ admit: admitted.resolve, signal: t.signal });
    const child = await admitted.promise;
    await using client = new Client<{ late(): string }>(
      linkTo(new ChildProcessConnection(child, { tag })),
      { errors: new ErrorCodec([]), answers: { late: isString } },
    );
    const late = client.call('late', []).catch((error: unknown) => error);
    await peer.next('called', { signal: t.signal });

    // Act: the link goes before `late` answers.
    child.disconnect();

    // Assert: the process ends with 0 only after `ping` answered; a send to the lost link that threw would end it with an unhandled rejection first.
    assert.ok(Error.isError(await untilAborted(late, t.signal)));
    assert.deepEqual(
      await untilAborted(peer.process.ended, t.signal),
      { exitCode: 0 },
      peer.process.stderrTail(),
    );
  });
});
