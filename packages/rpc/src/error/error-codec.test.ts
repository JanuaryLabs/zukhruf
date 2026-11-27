import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { untilAborted } from '@zukhruf/async';

import {
  Client,
  ConnectionSupervisor,
  ErrorCodec,
  type RpcMessage,
  ServerError,
} from '../index.ts';
import { report, serving, threadConnector } from '../testing/threads.ts';

const isVoid = (answer: unknown): answer is void => answer === undefined;

/** A thread whose `fail(kind)` throws the thrown value of that kind, and first reports the stack of an error. */
const failing = serving(
  `{
		fail(kind) {
			class DatabaseError extends Error {
				constructor(message, code, options) {
					super(message, options);
					this.name = 'DatabaseError';
					this.code = code;
				}
			}
			class QuotaError extends Error {
				code = 'Q1';
			}
			const thrown = {
				listed: () => new DatabaseError('no such table: jobs', 'SQLITE_ERROR', { cause: new TypeError('bad name') }),
				unlisted: () => new QuotaError('over the quota'),
				native: () => new RangeError('out of range'),
				text: () => 'a string',
			}[kind]();
			if (Error.isError(thrown)) parentPort.postMessage({ stack: thrown.stack });
			throw thrown;
		},
	}`,
  `{ fail: (p) => p.length === 1 && typeof p[0] === 'string' }`,
);

describe('An error that crosses from a thread', () => {
  test('of a listed class arrives as that class with its code, message, stack and cause, and its constructor does not run', async (t) => {
    // Arrange: this end lists a class of the same name, whose constructor counts its runs.
    let constructed = 0;
    class DatabaseError extends Error {
      readonly code: string;
      constructor(message: string, code: string) {
        super(message);
        constructed++;
        this.code = code;
      }
    }
    await using threads = threadConnector<RpcMessage>(failing);
    await using client = new Client<{ fail(kind: string): void }>(
      new ConnectionSupervisor(threads.connector),
      { errors: new ErrorCodec([DatabaseError]), answers: { fail: isVoid } },
    );

    // Act
    const call = client.call('fail', ['listed']);
    const stack = report(threads.threads[0]!, t.signal);
    const failure: unknown = await untilAborted(call, t.signal).catch(
      (error: unknown) => error,
    );

    // Assert
    assert.ok(failure instanceof DatabaseError, String(failure));
    assert.ok(Error.isError(failure), 'It must be a native error');
    assert.equal(failure.name, 'DatabaseError');
    assert.equal(failure.code, 'SQLITE_ERROR');
    assert.equal(failure.message, 'no such table: jobs');
    assert.deepEqual(
      { stack: failure.stack },
      await stack,
      'It must keep the stack of the thread',
    );
    assert.ok(failure.cause instanceof TypeError, String(failure.cause));
    assert.equal(failure.cause.message, 'bad name');
    assert.equal(constructed, 0, 'The constructor of the class must not run');
  });

  test('of a class that this end does not list arrives as a ServerError with its name, message and fields', async (t) => {
    // Arrange
    await using threads = threadConnector<RpcMessage>(failing);
    await using client = new Client<{ fail(kind: string): void }>(
      new ConnectionSupervisor(threads.connector),
      { errors: new ErrorCodec([]), answers: { fail: isVoid } },
    );

    // Act
    const failure: unknown = await untilAborted(
      client.call('fail', ['unlisted']),
      t.signal,
    ).catch((error: unknown) => error);

    // Assert
    assert.ok(failure instanceof ServerError, String(failure));
    assert.deepEqual(
      {
        name: failure.name,
        message: failure.message,
        code: Reflect.get(failure, 'code'),
      },
      { name: 'QuotaError', message: 'over the quota', code: 'Q1' },
    );
  });

  test('of a native class arrives as that class without a list, and a thrown value that is not an error arrives as it is', async (t) => {
    // Arrange
    await using threads = threadConnector<RpcMessage>(failing);
    await using client = new Client<{ fail(kind: string): void }>(
      new ConnectionSupervisor(threads.connector),
      { errors: new ErrorCodec([]), answers: { fail: isVoid } },
    );

    // Act
    const native: unknown = await untilAborted(
      client.call('fail', ['native']),
      t.signal,
    ).catch((error: unknown) => error);
    const text: unknown = await untilAborted(
      client.call('fail', ['text']),
      t.signal,
    ).catch((error: unknown) => error);

    // Assert
    assert.ok(native instanceof RangeError, String(native));
    assert.equal(native.message, 'out of range');
    assert.equal(text, 'a string');
  });
});

describe('A codec', () => {
  test('refuses two classes of one name, because the name is what crosses', () => {
    // Arrange: two classes named DatabaseError, and one that takes a native class's name.
    const named = () => class DatabaseError extends Error {};
    class TypeError extends Error {}

    // Act and Assert
    assert.throws(() => new ErrorCodec([named(), named()]), RangeError);
    assert.throws(() => new ErrorCodec([TypeError]), RangeError);
  });
});
