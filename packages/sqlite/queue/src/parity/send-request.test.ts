import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ParityRun } from './backends.ts';
import { Parity } from './parity.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// What a call did: the value it resolved with, or the error class and
// message it rejected with.
async function outcome(call: () => Promise<unknown>) {
  try {
    return { resolved: await call() };
  } catch (error) {
    return error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  }
}

describe('send(request)', () => {
  it('takes { name, data, options } and checks it the way pg-boss does', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      const results = {
        request: await outcome(() =>
          queue.send({
            name: 'jobs',
            data: { a: 1 },
            options: { id: id(1), priority: 2, startAfter: 60 },
          }),
        ),
        noData: await outcome(() =>
          queue.send({ name: 'jobs', options: { id: id(2) } }),
        ),
        // A function payload is refused only on the positional form; the
        // request form serializes it away.
        functionData: await outcome(() =>
          queue.send({ name: 'jobs', data: () => 1, options: { id: id(3) } }),
        ),
        extraField: await outcome(() =>
          queue.send(
            JSON.parse(
              `{"name":"jobs","data":{"b":2},"options":{"id":"${id(4)}"},"extra":1}`,
            ),
          ),
        ),
        stringOptions: await outcome(() =>
          queue.send(JSON.parse('{"name":"jobs","options":"fast"}')),
        ),
        badPriority: await outcome(() =>
          queue.send({ name: 'jobs', options: { priority: 1.5 } }),
        ),
        secondArgument: await outcome(() =>
          queue.send(JSON.parse('{"name":"jobs"}'), { a: 1 }),
        ),
        secondArgumentUndefined: await outcome(() =>
          queue.send(JSON.parse('{"name":"jobs"}'), undefined),
        ),
        nullRequest: await outcome(() => queue.send(JSON.parse('null'))),
        noName: await outcome(() => queue.send(JSON.parse('{}'))),
        numberName: await outcome(() => queue.send(JSON.parse('{"name":5}'))),
        badName: await outcome(() => queue.send({ name: 'bad name!' })),
        missingQueue: await outcome(() => queue.send({ name: 'missing' })),
        numberFirst: await outcome(() => queue.send(JSON.parse('5'))),
        numberFirstFunctionData: await outcome(() =>
          queue.send(JSON.parse('5'), () => 1),
        ),
      };
      // A request without options gets an id pg-boss generates.
      const generated = await queue.send(
        JSON.parse('{"name":"jobs","options":null}'),
      );
      const jobs = (await queue.findJobs('jobs'))
        .map(({ id, data, priority, startAfter }) => ({
          id: id === generated ? 'generated' : id,
          data,
          priority,
          startAfter: startAfter.getTime() - Date.parse(ParityRun.start),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { results, generated: typeof generated, jobs };
    });

    // checkSendArgs (node_modules/pg-boss/dist/attorney.js:118-153): a
    // string first argument is the positional form, any other object the
    // request form with exactly one argument, and anything else has no name.
    // createJob stores the payload through JSON (manager.js:1232-1243).
    const rejects = (message: string) => `AssertionError: ${message}`;
    const noQueueName = rejects('boss requires all jobs to have a queue name');
    assert.deepStrictEqual(observed, {
      results: {
        request: { resolved: id(1) },
        noData: { resolved: id(2) },
        functionData: { resolved: id(3) },
        extraField: { resolved: id(4) },
        stringOptions: rejects('options should be an object'),
        badPriority: rejects('priority must be an integer'),
        secondArgument: rejects('send object API only accepts 1 argument'),
        secondArgumentUndefined: rejects(
          'send object API only accepts 1 argument',
        ),
        nullRequest: rejects('boss requires all jobs to have a name'),
        noName: noQueueName,
        numberName: rejects('Name must be a string'),
        badName: rejects(
          'Name can only contain alphanumeric characters, underscores, hyphens, periods, or forward slashes',
        ),
        missingQueue: 'Error: Queue missing does not exist',
        numberFirst: noQueueName,
        numberFirstFunctionData: noQueueName,
      },
      generated: 'string',
      jobs: [
        { id: id(1), data: { a: 1 }, priority: 2, startAfter: 60000 },
        { id: id(2), data: null, priority: 0, startAfter: 0 },
        { id: id(3), data: null, priority: 0, startAfter: 0 },
        { id: id(4), data: { b: 2 }, priority: 0, startAfter: 0 },
        { id: 'generated', data: null, priority: 0, startAfter: 0 },
      ],
    });
  });

  it('reads options from the copy checkSendArgs makes, so inherited ones are ignored on both forms', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      const inherited = (n: number) =>
        Object.assign(Object.create({ priority: 1.5, retryLimit: -1 }), {
          id: id(n),
        });
      const results = {
        request: await outcome(() =>
          queue.send({ name: 'jobs', options: inherited(1) }),
        ),
        positional: await outcome(() => queue.send('jobs', null, inherited(2))),
      };
      const jobs = (await queue.findJobs('jobs'))
        .map(({ id, priority, retryLimit }) => ({ id, priority, retryLimit }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { results, jobs };
    });

    // checkSendArgs validates and returns `{ ...options }` (attorney.js:137),
    // own properties only.
    assert.deepStrictEqual(observed, {
      results: {
        request: { resolved: id(1) },
        positional: { resolved: id(2) },
      },
      jobs: [
        { id: id(1), priority: 0, retryLimit: 2 },
        { id: id(2), priority: 0, retryLimit: 2 },
      ],
    });
  });
});
