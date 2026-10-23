import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Parity } from './parity.ts';

const lower = '0000000a-0000-4000-8000-00000000000b';
const hex = lower.replaceAll('-', '');
const bare = hex.replace(/^0/, '1');
const everyFour = hex.replace(/^0/, '2');
const bracedBare = hex.replace(/^0/, '3');
const firstFour = hex.replace(/^0/, '4');
const canonical = (value: string) =>
  `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;

// What a call did: its result, or the error class, message and SQLSTATE it
// rejected with.
async function outcome(call: () => Promise<unknown>) {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof Error)) {
      return String(error);
    }
    const code = 'code' in error ? ` (${error.code})` : '';
    return `${error.name}: ${error.message}${code}`;
  }
}

describe('job ids', () => {
  it('take every spelling the uuid type accepts, store it canonical, and reject the rest', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      const send = (id: string) =>
        outcome(() => queue.send('jobs', null, { id }));
      const sent = {
        upper: await send(lower.toUpperCase()),
        braces: await send(`{${lower}}`),
        bare: await send(bare),
        hyphenEveryFour: await send(everyFour.replace(/(.{4})(?!$)/g, '$1-')),
        notUuid: await send('id-1'),
        empty: await send(''),
        unclosedBrace: await send(`{${lower}`),
        padded: await send(` ${lower}`),
        bracesBare: await send(`{${bracedBare}}`),
        hyphenAfterFirstFour: await send(
          `${firstFour.slice(0, 4)}-${firstFour.slice(4)}`,
        ),
        trailingHyphen: await send(`${lower}-`),
        leadingHyphen: await send(`-${lower}`),
        doubleHyphen: await send(lower.replace('-', '--')),
        closingBraceOnly: await send(`${lower}}`),
        trailingNewline: await send(`${lower}\n`),
        shortByOne: await send(hex.slice(1)),
        longByOne: await send(`${hex}0`),
      };
      // Untyped callers' ids arrive as parsed JSON.
      const untyped = {
        sendArray: await outcome(() =>
          queue.send('jobs', null, { id: JSON.parse(`["${lower}"]`) }),
        ),
        sendObject: await outcome(() =>
          queue.send('jobs', null, { id: JSON.parse('{}') }),
        ),
        sendNumber: await outcome(() =>
          queue.send('jobs', null, { id: JSON.parse('5') }),
        ),
        findNull: await outcome(() =>
          queue.findJobs('jobs', { id: JSON.parse('null') }),
        ),
      };
      const found = {
        byUpper: (
          await queue.findJobs('jobs', { id: lower.toUpperCase() })
        ).map((job) => job.id),
        byBare: (await queue.findJobs('jobs', { id: hex })).map(
          (job) => job.id,
        ),
        notUuid: await outcome(() => queue.findJobs('jobs', { id: 'id-1' })),
      };
      const settled = {
        cancelSpellings: await outcome(() =>
          queue.cancel('jobs', [
            `{${canonical(everyFour).toUpperCase()}}`,
            canonical(everyFour),
          ]),
        ),
        cancelOnMissingQueue: await outcome(() =>
          queue.cancel('missing', 'id-1'),
        ),
        failNotUuidAndNotJson: await outcome(() =>
          queue.fail('jobs', 'id-1', new Date(0)),
        ),
        sendNotUuidWithBadPriority: await outcome(() =>
          queue.send('jobs', null, { id: 'id-1', priority: 1.5 }),
        ),
        cancelNotUuid: await outcome(() => queue.cancel('jobs', 'id-1')),
        failUpper: await outcome(() => queue.fail('jobs', lower.toUpperCase())),
        failNotUuid: await outcome(() => queue.fail('jobs', ['id-1'])),
      };
      const jobs = await queue.findJobs('jobs');
      return {
        sent,
        untyped,
        found,
        settled,
        stored: jobs.map((job) => job.id).sort(),
      };
    });

    // Postgres's uuid input accepts upper case, braces and hyphens after any
    // four digits, and prints the canonical form; pg-boss binds every id as a
    // uuid, so the duplicate spelling of a sent id inserts nothing.
    const invalid = (value: string) =>
      `error: invalid input syntax for type uuid: "${value}" (22P02)`;
    assert.deepStrictEqual(observed, {
      sent: {
        upper: lower,
        braces: null,
        bare: canonical(bare),
        hyphenEveryFour: canonical(everyFour),
        notUuid: invalid('id-1'),
        empty: invalid(''),
        unclosedBrace: invalid(`{${lower}`),
        padded: invalid(` ${lower}`),
        bracesBare: canonical(bracedBare),
        hyphenAfterFirstFour: canonical(firstFour),
        trailingHyphen: invalid(`${lower}-`),
        leadingHyphen: invalid(`-${lower}`),
        doubleHyphen: invalid(lower.replace('-', '--')),
        closingBraceOnly: invalid(`${lower}}`),
        trailingNewline: invalid(`${lower}\n`),
        shortByOne: invalid(hex.slice(1)),
        longByOne: invalid(`${hex}0`),
      },
      // send() reads its id out of a JSON payload (plans.js:2303); findJobs()
      // binds it, and NULL matches nothing (plans.js:3694).
      untyped: {
        sendArray: invalid(`["${lower}"]`),
        sendObject: invalid('{}'),
        sendNumber: invalid('5'),
        findNull: [],
      },
      found: { byUpper: [lower], byBare: [lower], notUuid: invalid('id-1') },
      settled: {
        // jobs echoes each spelling; the uuid type settles the job once.
        cancelSpellings: {
          jobs: [
            `{${canonical(everyFour).toUpperCase()}}`,
            canonical(everyFour),
          ],
          requested: 2,
          affected: 1,
          settled: [canonical(everyFour)],
        },
        // The queue is looked up before any id is cast, the priority checked
        // before the insert, and the ids cast before the output
        // (manager.js:1691, 1957-1961).
        cancelOnMissingQueue: 'Error: Queue missing does not exist',
        sendNotUuidWithBadPriority:
          'AssertionError: priority must be an integer (ERR_ASSERTION)',
        failNotUuidAndNotJson: invalid('id-1'),
        cancelNotUuid: invalid('id-1'),
        failUpper: {
          jobs: [lower.toUpperCase()],
          requested: 1,
          affected: 1,
          settled: [lower],
        },
        failNotUuid: invalid('id-1'),
      },
      stored: [hex, bare, everyFour, bracedBare, firstFour]
        .map(canonical)
        .sort(),
    });
  });
});
