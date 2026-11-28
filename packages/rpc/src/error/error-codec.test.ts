import assert from 'node:assert/strict';

import { untilAborted } from '@zukhruf/async';
import { describe, test } from '@zukhruf/parameterized-test';

import {
  Client,
  ConnectionSupervisor,
  ErrorCodec,
  type RpcMessage,
  ServerError,
  isEncodedReason,
} from '../index.ts';
import { report, serving, threadConnector } from '../testing/threads.ts';

const isVoid = (answer: unknown): answer is void => answer === undefined;

/** A thread whose `fail(kind)` throws the thrown value of that kind, and first reports the stack of an error. */
const failing = serving(
  `{
		async fail(kind) {
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
			const made = {
				listed: () => new DatabaseError('no such table: jobs', 'SQLITE_ERROR', { cause: new TypeError('bad name') }),
				unlisted: () => new QuotaError('over the quota'),
				native: () => new RangeError('out of range'),
				text: () => 'a string',
				abort: () => {
					const controller = new AbortController();
					controller.abort();
					return controller.signal.reason;
				},
				timeout: () => {
					const signal = AbortSignal.timeout(1);
					return new Promise((resolve) => signal.addEventListener('abort', () => resolve(signal.reason)));
				},
				clone: () => {
					try {
						structuredClone(new WeakMap());
					} catch (refusal) {
						return refusal;
					}
				},
				causedDomException: () => new DOMException('stopped', { name: 'AbortError', cause: new DatabaseError('no such table: jobs', 'SQLITE_ERROR') }),
				domExceptionAsCause: () => new Error('the job stopped', { cause: new DOMException('stopped', 'AbortError') }),
				fake: () => Object.defineProperties(Object.create(DOMException.prototype), {
					name: { value: 'AbortError', enumerable: true },
					message: { value: 'stopped', enumerable: true },
				}),
				subclass: () => new (class JobAbort extends DOMException {})('stopped', 'AbortError'),
			}[kind]();
			const thrown = await made;
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
    const reported = await stack;

    // Assert
    assert.ok(failure instanceof DatabaseError, String(failure));
    assert.ok(Error.isError(failure), 'It must be a native error');
    assert.equal(failure.name, 'DatabaseError');
    assert.equal(failure.code, 'SQLITE_ERROR');
    assert.equal(failure.message, 'no such table: jobs');
    assert.deepEqual(
      { stack: failure.stack },
      reported,
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

  test('as an object that only has the prototype of DOMException arrives as a thrown value that is not an error, because it is no DOMException', async (t) => {
    // Arrange
    await using threads = threadConnector<RpcMessage>(failing);
    await using client = new Client<{ fail(kind: string): void }>(
      new ConnectionSupervisor(threads.connector),
      { errors: new ErrorCodec([]), answers: { fail: isVoid } },
    );

    // Act
    const failure: unknown = await untilAborted(
      client.call('fail', ['fake']),
      t.signal,
    ).catch((error: unknown) => error);

    // Assert
    assert.equal(failure instanceof DOMException, false, String(failure));
    assert.deepEqual(failure, { name: 'AbortError', message: 'stopped' });
  });

  void test.each(
    [
      {
        kind: 'abort',
        of: 'the DOMException AbortError of an aborted signal',
        expected: {
          name: 'AbortError',
          code: 20,
          message: 'This operation was aborted',
        },
      },
      {
        kind: 'timeout',
        of: 'the DOMException TimeoutError of a timed-out signal',
        expected: {
          name: 'TimeoutError',
          code: 23,
          message: 'The operation was aborted due to timeout',
        },
      },
      {
        kind: 'clone',
        of: 'the DOMException DataCloneError of a refused clone',
        expected: {
          name: 'DataCloneError',
          code: 25,
          message: '#<WeakMap> could not be cloned.',
        },
      },
    ],
    ({ kind, of, expected }) =>
      test(`as ${of} arrives as that DOMException, with its code, message and stack, and with no cause`, async (t) => {
        // Arrange
        await using threads = threadConnector<RpcMessage>(failing);
        await using client = new Client<{ fail(kind: string): void }>(
          new ConnectionSupervisor(threads.connector),
          { errors: new ErrorCodec([]), answers: { fail: isVoid } },
        );

        // Act
        const call = client.call('fail', [kind]);
        const stack = report(threads.threads[0]!, t.signal);
        const failure: unknown = await untilAborted(call, t.signal).catch(
          (error: unknown) => error,
        );
        const reported = await stack;

        // Assert
        assert.ok(failure instanceof DOMException, String(failure));
        assert.deepEqual(
          { name: failure.name, code: failure.code, message: failure.message },
          expected,
        );
        assert.deepEqual(
          { stack: failure.stack },
          reported,
          'It must keep the stack of the thread',
        );
        assert.equal(
          Object.hasOwn(failure, 'cause'),
          false,
          'A DOMException made with no cause must arrive with no cause',
        );
      }),
  );

  test('as a DOMException with a cause arrives with its cause, which crosses as any thrown value', async (t) => {
    // Arrange: this end lists the class of the cause, which the structured clone alone would turn into a plain Error with no code.
    class DatabaseError extends Error {
      code = '';
    }
    await using threads = threadConnector<RpcMessage>(failing);
    await using client = new Client<{ fail(kind: string): void }>(
      new ConnectionSupervisor(threads.connector),
      { errors: new ErrorCodec([DatabaseError]), answers: { fail: isVoid } },
    );

    // Act
    const failure: unknown = await untilAborted(
      client.call('fail', ['causedDomException']),
      t.signal,
    ).catch((error: unknown) => error);

    // Assert
    assert.ok(failure instanceof DOMException, String(failure));
    assert.equal(failure.name, 'AbortError');
    assert.ok(failure.cause instanceof DatabaseError, String(failure.cause));
    assert.deepEqual(
      { message: failure.cause.message, code: failure.cause.code },
      { message: 'no such table: jobs', code: 'SQLITE_ERROR' },
    );
  });

  test('with a DOMException as its cause arrives with that DOMException as its cause', async (t) => {
    // Arrange
    await using threads = threadConnector<RpcMessage>(failing);
    await using client = new Client<{ fail(kind: string): void }>(
      new ConnectionSupervisor(threads.connector),
      { errors: new ErrorCodec([]), answers: { fail: isVoid } },
    );

    // Act
    const failure: unknown = await untilAborted(
      client.call('fail', ['domExceptionAsCause']),
      t.signal,
    ).catch((error: unknown) => error);

    // Assert
    assert.ok(Error.isError(failure), String(failure));
    assert.ok(failure.cause instanceof DOMException, String(failure.cause));
    assert.deepEqual(
      {
        name: failure.cause.name,
        code: failure.cause.code,
        message: failure.cause.message,
      },
      { name: 'AbortError', code: 20, message: 'stopped' },
    );
  });

  test('as a subclass of DOMException arrives as a DOMException of no subclass, as the structured clone gives it', async (t) => {
    // Arrange
    await using threads = threadConnector<RpcMessage>(failing);
    await using client = new Client<{ fail(kind: string): void }>(
      new ConnectionSupervisor(threads.connector),
      { errors: new ErrorCodec([]), answers: { fail: isVoid } },
    );

    // Act
    const failure: unknown = await untilAborted(
      client.call('fail', ['subclass']),
      t.signal,
    ).catch((error: unknown) => error);

    // Assert
    assert.ok(failure instanceof DOMException, String(failure));
    assert.equal(Object.getPrototypeOf(failure), DOMException.prototype);
    assert.deepEqual(
      { name: failure.name, code: failure.code, message: failure.message },
      { name: 'AbortError', code: 20, message: 'stopped' },
    );
  });
});

describe('A received reason', () => {
  void test.each(
    [
      {
        envelope: 'a DOMException with a name that is no string',
        domException: { name: 20, message: 'stopped', stack: undefined },
      },
      {
        envelope: 'a DOMException with a message that is no string',
        domException: { name: 'AbortError', message: null, stack: undefined },
      },
      {
        envelope: 'a DOMException with a stack that is a number',
        domException: { name: 'AbortError', message: 'stopped', stack: 1 },
      },
      {
        envelope: 'a DOMException with a cause of no encoded shape',
        domException: {
          name: 'AbortError',
          message: 'stopped',
          stack: undefined,
          cause: { name: 'TypeError' },
        },
      },
    ],
    ({ envelope, domException }) =>
      test(`is refused as ${envelope}`, () => {
        // Act
        const accepted = isEncodedReason({ domException });

        // Assert
        assert.equal(accepted, false);
      }),
  );

  test('is accepted as a DOMException with a stack and an encoded cause', () => {
    // Act
    const accepted = isEncodedReason({
      domException: {
        name: 'AbortError',
        message: 'stopped',
        stack: 'AbortError: stopped',
        cause: { value: 'a string' },
      },
    });

    // Assert
    assert.equal(accepted, true);
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
