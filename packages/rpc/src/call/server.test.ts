import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, test } from 'node:test';

import { untilAborted } from '@zukhruf/async';

import {
  ChildProcessConnection,
  ErrorCodec,
  Server,
  ServerWarning,
  WorkerConnection,
} from '../index.ts';
import { report, startAsker, startThread, tag } from '../testing/threads.ts';

const noParams = (params: readonly unknown[]): params is [] =>
  params.length === 0;

describe('A server', () => {
  test('refuses a method of its target that it does not list, and does not run it', async (t) => {
    // Arrange: the target has `secret`, but the server lists only `ping`.
    let ran = false;
    await using asker = startAsker(
      `
				const secret = await client.call('secret', []).then(() => 'answered', (error) => error.name);
				process.send({ type: 'secret', secret });
			`,
      `{ secret: (answer) => answer === undefined }`,
    );
    new Server(
      {
        secret: () => {
          ran = true;
        },
        ping: () => 'pong',
      },
      { methods: { ping: noParams }, errors: new ErrorCodec([]) },
    ).serve(new ChildProcessConnection(asker.child, { tag }));

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
    await using asker = startAsker(
      `
				const sum = await client.call('add', ['1', '2']).then(String, (error) => error.name);
				process.send({ type: 'sum', sum });
			`,
      `{ add: (answer) => typeof answer === 'number' }`,
    );
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
    ).serve(new ChildProcessConnection(asker.child, { tag }));

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
      ).serve(new WorkerConnection(thread, { tag }));

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
    ).serve(new WorkerConnection(thread, { tag }));

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
