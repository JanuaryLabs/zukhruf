import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TestClock } from 'pg-boss';

import { Parity } from './parity.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Lets everything due now finish on both backends: tick(0) waits until each
// one's statements in flight have settled, SQLite's through its attached
// Activity (node_modules/pg-boss/dist/clock.js:88-117, activity.js:77-93).
async function flush(clock: TestClock) {
  await clock.tick(0);
}

// An output with each serialized error's stack replaced by whether it was
// there, since stacks differ by backend and line.
function withoutStacks(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(withoutStacks);
  }
  const isError = 'name' in value && 'message' in value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) =>
      isError && key === 'stack'
        ? ['hasStack', typeof item === 'string']
        : [key, withoutStacks(item)],
    ),
  );
}

// The fields a driver error shares across drivers; the rest (file, line,
// routine, ...) are Postgres's own diagnostics.
function driverError(error: unknown) {
  if (error === null || typeof error !== 'object') {
    return error;
  }
  return {
    name: 'name' in error ? error.name : undefined,
    message: 'message' in error ? error.message : undefined,
    code: 'code' in error ? error.code : undefined,
  };
}

describe('outputs', () => {
  it('store what a one-job handler returns or throws, as pg-boss serializes it', async () => {
    const returns: Record<string, () => unknown> = {
      object: () => ({ a: 1 }),
      array: () => [1, 2],
      text: () => 'text',
      number: () => 7,
      nothing: () => undefined,
      empty: () => null,
      callback: () => () => 1,
      nestedError: () => ({ cause: new Error('inner') }),
      jsonText: () => ({ toJSON: () => '{"a":1}' }),
      jsonNothing: () => ({ toJSON: () => undefined }),
      returnedError: () => new Error('returned'),
      thrown: () => {
        throw new Error('boom');
      },
      thrownText: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- The scenario: a handler that throws a string, which pg-boss stores as the failure output.
        throw 'boom';
      },
      thrownObject: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- The scenario: a handler that throws a plain object, which pg-boss stores as the failure output.
        throw { code: 1 };
      },
      thrownWithCause: () => {
        throw new Error('outer', { cause: new Error('inner') });
      },
    };
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      for (const [n, [name, value]] of Object.entries(returns).entries()) {
        await queue.createQueue(name, { retryLimit: 0 });
        await queue.send(name, null, { id: id(n + 1) });
        await queue.work(name, {}, async () => value());
      }
      await queue.createQueue('batch');
      await queue.send('batch', null, { id: id(20) });
      await queue.send('batch', null, { id: id(21) });
      await queue.work('batch', { batchSize: 2 }, async () => ({ a: 1 }));
      await queue.createQueue('batchThrown', { retryLimit: 0 });
      await queue.send('batchThrown', null, { id: id(22) });
      await queue.send('batchThrown', null, { id: id(23) });
      await queue.work('batchThrown', { batchSize: 2 }, async () => {
        throw new Error('batch');
      });
      await flush(clock);
      const outputs: Record<string, unknown> = {};
      for (const name of [...Object.keys(returns), 'batch', 'batchThrown']) {
        const jobs = await queue.findJobs(name);
        outputs[name] = jobs.map((job) => ({
          state: job.state,
          output: withoutStacks(job.output),
        }));
      }
      return outputs;
    });

    // complete() stores the result only for a one-job batch (manager.js:628),
    // through mapCompletionDataArg: null, undefined and functions as null,
    // objects as they are, anything else as { value }, all through
    // serialize-error (manager.js:1614-1622); a throw fails the job with the
    // serialized error (manager.js:639-655).
    const completed = (output: unknown) => [{ state: 'completed', output }];
    const failed = (output: unknown) => ({ state: 'failed', output });
    assert.deepStrictEqual(observed, {
      object: completed({ a: 1 }),
      array: completed({ value: [1, 2] }),
      text: completed({ value: 'text' }),
      number: completed({ value: 7 }),
      nothing: completed(null),
      empty: completed(null),
      callback: completed(null),
      nestedError: completed({
        cause: { name: 'Error', message: 'inner', hasStack: true },
      }),
      jsonText: completed({ a: 1 }),
      jsonNothing: completed(null),
      returnedError: completed({
        name: 'Error',
        message: 'returned',
        hasStack: true,
      }),
      thrown: [failed({ name: 'Error', message: 'boom', hasStack: true })],
      thrownText: [failed({ value: 'boom' })],
      thrownObject: [failed({ code: 1 })],
      thrownWithCause: [
        failed({
          name: 'Error',
          message: 'outer',
          hasStack: true,
          cause: { name: 'Error', message: 'inner', hasStack: true },
        }),
      ],
      batch: [
        { state: 'completed', output: null },
        { state: 'completed', output: null },
      ],
      batchThrown: [
        failed({ name: 'Error', message: 'batch', hasStack: true }),
        failed({ name: 'Error', message: 'batch', hasStack: true }),
      ],
    });
  });

  it('store what fail() is given, and reject what jsonb cannot store', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('given', { retryLimit: 0 });
      await queue.send('given', null, { id: id(1) });
      await queue.fail('given', id(1), { a: 1 });
      const rejected: Record<string, unknown> = {};
      const inputs: Record<string, object> = {
        date: new Date(0),
        nul: { text: 'a\u0000b' },
        nulKey: { 'a\u0000b': 1 },
        lone: { text: 'a\ud800' },
        loneKey: { 'k\udc00': 1 },
        bigint: { n: 1n },
      };
      for (const [n, [name, data]] of Object.entries(inputs).entries()) {
        await queue.createQueue(name, { retryLimit: 0 });
        await queue.send(name, null, { id: id(n + 2) });
        const error = await queue.fail(name, id(n + 2), data).then(
          () => null,
          (thrown: unknown) => thrown,
        );
        const [job] = await queue.findJobs(name);
        rejected[name] = { error: driverError(error), state: job?.state };
      }
      await queue.createQueue('returnsDate', { retryLimit: 0 });
      await queue.send('returnsDate', null, { id: id(9) });
      await queue.work('returnsDate', {}, async () => new Date(0));
      await flush(clock);
      const [given] = await queue.findJobs('given');
      const [returnsDate] = await queue.findJobs('returnsDate');
      return {
        given: { state: given?.state, output: given?.output },
        rejected,
        returnsDate: {
          state: returnsDate?.state,
          output: driverError(returnsDate?.output),
        },
      };
    });

    // Both drivers bind a string as JSON text: a Date serializes to its ISO
    // string, which jsonb rejects (22P02), as it rejects \u0000 (22P05) and an
    // unpaired surrogate (22P02); serialize-error turns a bigint into "1n"
    // before the driver sees it (manager.js:1614-1622). A
    // rejected fail() changes nothing; a rejected completion fails the job
    // with the driver's error (manager.js:628, 639-655).
    const invalidJson = {
      name: 'error',
      message: 'invalid input syntax for type json',
      code: '22P02',
    };
    const unsupportedEscape = {
      name: 'error',
      message: 'unsupported Unicode escape sequence',
      code: '22P05',
    };
    assert.deepStrictEqual(observed, {
      given: { state: 'failed', output: { a: 1 } },
      rejected: {
        date: { error: invalidJson, state: 'created' },
        nul: { error: unsupportedEscape, state: 'created' },
        nulKey: { error: unsupportedEscape, state: 'created' },
        lone: { error: invalidJson, state: 'created' },
        loneKey: { error: invalidJson, state: 'created' },
        bigint: { error: null, state: 'failed' },
      },
      returnsDate: { state: 'failed', output: invalidJson },
    });
  });
});
