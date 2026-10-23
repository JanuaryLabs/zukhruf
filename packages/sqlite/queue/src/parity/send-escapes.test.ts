import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SendOptions } from 'pg-boss';

import { Parity } from './parity.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// What a call did: 'resolved', or the error class, message and code it
// rejected with.
async function outcome(call: () => Promise<unknown>) {
  try {
    await call();
    return 'resolved';
  } catch (error) {
    if (!(error instanceof Error)) {
      return String(error);
    }
    const code =
      'code' in error && typeof error.code === 'string'
        ? ` (${error.code})`
        : '';
    return `${error.name}: ${error.message}${code}`;
  }
}

// Values the declared types refuse arrive as parsed JSON, the way an untyped
// caller sends them.
const untyped = (json: string) => JSON.parse(json);

describe('send escapes', () => {
  it("refuses the first escape the job's JSON text cannot store, in any field, after the queue checks", async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.createQueue('strict', { policy: 'key_strict_fifo' });
      let n = 1;
      const send = (data: object | null, options: SendOptions = {}) =>
        outcome(() => queue.send('jobs', data, { id: id(n++), ...options }));
      const results = {
        // A reply cut to its first UTF-16 unit splits the emoji's pair.
        emojiSliced: await send({ text: '😀 done'.slice(0, 1) }),
        emojiWhole: await send({ text: '😀 done' }),
        dataNul: await send({ s: 'a\u0000b' }),
        dataNulKey: await send({ 'a\u0000': 1 }),
        dataStringNul: await send(untyped('"a\\u0000b"')),
        dataStringLone: await send(untyped('"\\ud800"')),
        singletonKeyLone: await send(null, { singletonKey: 'k\ud800' }),
        singletonKeyNul: await send(null, { singletonKey: 'k\u0000' }),
        groupIdLone: await send(null, { group: { id: 'g\udc00' } }),
        groupTierNul: await send(null, { group: { id: 'g', tier: 't\u0000' } }),
        deadLetterLone: await send(null, { deadLetter: 'd\ud800' }),
        deadLetterNul: await send(null, { deadLetter: 'd\u0000' }),
        startAfterLone: await send(null, { startAfter: '2026-01-01\ud800' }),
        startAfterNul: await send(null, { startAfter: '2026-01-01\u0000' }),
        singletonSecondsLone: await send(
          null,
          untyped('{"singletonSeconds":"\\ud800"}'),
        ),
        idLone: await outcome(() =>
          queue.send('jobs', null, { id: 'x\ud800' }),
        ),
        idNul: await outcome(() => queue.send('jobs', null, { id: 'x\u0000' })),
        loneDataBeforeNulKey: await send(
          { s: '\ud800' },
          { singletonKey: 'k\u0000' },
        ),
        nulDataBeforeLoneKey: await send(
          { s: 'a\u0000' },
          { singletonKey: 'k\ud800' },
        ),
        nulBeforeLoneInData: await send({ a: '\u0000', b: '\ud800' }),
        requestLone: await outcome(() =>
          queue.send({
            name: 'jobs',
            data: { s: '\ud800' },
            options: { id: id(n++) },
          }),
        ),
        requestNul: await outcome(() =>
          queue.send({
            name: 'jobs',
            options: { id: id(n++), singletonKey: '\u0000' },
          }),
        ),
        missingQueueFirst: await outcome(() =>
          queue.send('missing', { s: '\ud800' }),
        ),
        strictKeyFirst: await outcome(() =>
          queue.send('strict', { s: '\ud800' }),
        ),
        strictLoneKey: await outcome(() =>
          queue.send('strict', null, { singletonKey: '\ud800' }),
        ),
        debounceLone: await send(
          { s: '\ud800' },
          {
            singletonKey: 'debounce',
            singletonSeconds: 60,
            singletonNextSlot: true,
          },
        ),
      };
      const stored = (await queue.findJobs('jobs')).map(({ id, data }) => ({
        id,
        data,
      }));
      return { results, stored };
    });

    // createJob looks the queue up and checks key_strict_fifo first, then
    // sends the job as JSON.stringify([job]) (node_modules/pg-boss/dist/
    // manager.js:1208-1242), which json_to_recordset reads (plans.js:2303).
    // Postgres refuses the first escape in that text no field can hold, in
    // the job's field order: \u0000 (22P05) or a surrogate not paired
    // high-then-low (22P02). Nothing is stored.
    const invalidJson = 'error: invalid input syntax for type json (22P02)';
    const unsupportedEscape =
      'error: unsupported Unicode escape sequence (22P05)';
    assert.deepStrictEqual(observed, {
      results: {
        emojiSliced: invalidJson,
        emojiWhole: 'resolved',
        dataNul: unsupportedEscape,
        dataNulKey: unsupportedEscape,
        dataStringNul: unsupportedEscape,
        dataStringLone: invalidJson,
        singletonKeyLone: invalidJson,
        singletonKeyNul: unsupportedEscape,
        groupIdLone: invalidJson,
        groupTierNul: unsupportedEscape,
        deadLetterLone: invalidJson,
        deadLetterNul: unsupportedEscape,
        startAfterLone: invalidJson,
        startAfterNul: unsupportedEscape,
        singletonSecondsLone: invalidJson,
        idLone: invalidJson,
        idNul: unsupportedEscape,
        loneDataBeforeNulKey: invalidJson,
        nulDataBeforeLoneKey: unsupportedEscape,
        nulBeforeLoneInData: unsupportedEscape,
        requestLone: invalidJson,
        requestNul: unsupportedEscape,
        missingQueueFirst: 'Error: Queue missing does not exist',
        strictKeyFirst: 'Error: key_strict_fifo queues require a singletonKey',
        strictLoneKey: invalidJson,
        debounceLone: invalidJson,
      },
      stored: [{ id: id(2), data: { text: '😀 done' } }],
    });
  });
});
