import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ParityRun } from './backends.ts';
import { Parity } from './parity.ts';

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

// The schedule table as each backend holds it, read with SQL: no method of
// the 13 reads a schedule back (pg-boss's getSchedules is outside them, and
// no cron pass runs in these scenarios). jsonb columns arrive parsed from
// PGlite and as JSON text from SQLite; times as ms since the clock's start.
async function schedules({ backend, rows }: ParityRun) {
  const text =
    backend === 'pg-boss'
      ? 'SELECT name, key, kind, cron, timezone, data, options, created_on, updated_on FROM pgboss.schedule'
      : 'SELECT queue_name AS name, key, kind, cron, timezone, data, options, created_on, updated_on FROM pgboss_schedule';
  const json = (value: unknown) =>
    backend === 'sqlite' && typeof value === 'string'
      ? JSON.parse(value)
      : value;
  const since = (value: unknown) =>
    (value instanceof Date ? value.getTime() : Date.parse(String(value))) -
    Date.parse(ParityRun.start);
  return (await rows(text))
    .map((row) => ({
      name: String(row.name),
      key: String(row.key),
      kind: row.kind,
      cron: row.cron,
      timezone: row.timezone,
      data: json(row.data),
      options: json(row.options),
      created_on: since(row.created_on),
      updated_on: since(row.updated_on),
    }))
    .sort((a, b) => (`${a.name}/${a.key}` < `${b.name}/${b.key}` ? -1 : 1));
}

// Arguments the declared types refuse arrive as parsed JSON, the way an
// untyped caller sends them.
const untyped = (json: string) => JSON.parse(json);

describe('schedule', () => {
  it('validates its arguments the way pg-boss does, in pg-boss order', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      let n = 0;
      // Each accepted case files its own key, so none overwrites another.
      const schedule = (
        cron: string,
        options: Record<string, unknown> = {},
        name = 'jobs',
        data: object | null = null,
      ) =>
        outcome(() =>
          queue.schedule(name, cron, data, { key: `k${n++}`, ...options }),
        );
      return {
        cron: {
          invalidCharacters: await schedule('not a cron'),
          outOfRange: await schedule('61 * * * *'),
          dayOutOfRange: await schedule('0 0 32 * *'),
          tooManyFields: await schedule('* * * * * * *'),
          blank: await schedule('   '),
          unknownAlias: await schedule('every minute FREQ'),
          number: await schedule(untyped('5')),
          empty: await schedule(''),
          seconds: await schedule('*/10 * * * * *'),
          alias: await schedule('@daily'),
          names: await schedule('0 0 * JAN MON'),
          lastDay: await schedule('0 0 L * *'),
          nthWeekday: await schedule('0 0 * * MON#2'),
          question: await schedule('0 0 ? * MON'),
        },
        rrule: {
          beginLine: await schedule('BEGIN:VEVENT\nRRULE:FREQ=DAILY'),
          endLine: await schedule('RRULE:FREQ=DAILY\nEND:VEVENT'),
          property: await schedule('SUMMARY:standup\nRRULE:FREQ=DAILY'),
          twoDtstart: await schedule(
            'DTSTART:20260101T000000Z\nDTSTART:20260102T000000Z\nRRULE:FREQ=DAILY',
          ),
          twoRrule: await schedule('RRULE:FREQ=DAILY\nRRULE:FREQ=HOURLY'),
          noRrule: await schedule('RDATE:20260101T000000'),
          countWithoutDtstart: await schedule('FREQ=DAILY;COUNT=3'),
          exdateType: await schedule(
            'DTSTART:20260101T090000\nRRULE:FREQ=DAILY\nEXDATE;VALUE=DATE:20261224',
          ),
          rdateType: await schedule(
            'DTSTART;VALUE=DATE:20260101\nRRULE:FREQ=DAILY\nRDATE:20260105T090000',
          ),
          partWithoutValue: await schedule('FREQ=DAILY;BYHOUR'),
          unsupportedPart: await schedule('FREQ=DAILY;BYHOURS=9'),
          duplicatePart: await schedule('FREQ=DAILY;BYHOUR=9;BYHOUR=17'),
          valueOutOfRange: await schedule('FREQ=DAILY;BYHOUR=25'),
          listValueOutOfRange: await schedule('FREQ=DAILY;BYHOUR=9,25'),
          strict: await schedule('FREQ=WEEKLY;BYMONTHDAY=1'),
          badByday: await schedule('FREQ=WEEKLY;BYDAY=XX'),
          badWkst: await schedule('FREQ=WEEKLY;WKST=XX'),
          intervalZero: await schedule('FREQ=DAILY;INTERVAL=0'),
          noFreq: await schedule('RRULE:BYHOUR=9'),
          spentCount: await schedule(
            'DTSTART:20200101T000000Z\nRRULE:FREQ=DAILY;COUNT=1',
          ),
          spentUntil: await schedule('FREQ=DAILY;UNTIL=20200101T000000Z'),
          extensionPart: await schedule('FREQ=DAILY;X-NAME=foo'),
          lowercase: await schedule('freq=daily;byhour=9'),
          folded: await schedule(
            'DTSTART:20260101T090000\nRRULE:FREQ=DAILY\nEXDATE:20260102T090000,\n 20260103T090000',
          ),
          crlf: await schedule('DTSTART:20260101T090000\r\nRRULE:FREQ=DAILY'),
          blankLinesAndParts: await schedule('\n\nFREQ=DAILY;;BYHOUR=9;\n\n'),
          zonedDtstart: await schedule(
            'DTSTART;TZID=America/New_York:20260101T090000\nRRULE:FREQ=DAILY',
          ),
          rscale: await schedule(
            'RSCALE=GREGORIAN;FREQ=MONTHLY;BYMONTHDAY=31;SKIP=FORWARD',
          ),
          until: await schedule('FREQ=DAILY;UNTIL=20300101T000000Z'),
        },
        timezone: {
          unknown: await schedule('* * * * *', { tz: 'Mars/Base' }),
          number: await schedule('* * * * *', { tz: 5 }),
          rrule: await schedule('FREQ=DAILY', { tz: 'Mars/Base' }),
          empty: await schedule('* * * * *', { tz: '' }),
          null: await schedule('* * * * *', { tz: null }),
          named: await schedule('31 5 * * *', { tz: 'Asia/Kolkata' }),
        },
        options: {
          missedUnknown: await schedule('* * * * *', { missed: 'sometimes' }),
          missedNull: await schedule('* * * * *', { missed: null }),
          missedOnce: await schedule('* * * * *', { missed: 'once' }),
          badKey: await schedule('* * * * *', { key: 'bad key!' }),
          numberKey: await schedule('* * * * *', { key: 5 }),
          nullKey: await schedule('* * * * *', { key: null }),
          badRetry: await schedule('* * * * *', { retryLimit: -1 }),
          badPriority: await schedule('* * * * *', { priority: 1.5 }),
          undefinedPriority: await schedule('* * * * *', {
            priority: undefined,
          }),
          nullOptions: await outcome(() =>
            queue.schedule('jobs', '* * * * *', null, untyped('null')),
          ),
        },
        data: {
          function: await schedule('* * * * *', {}, 'jobs', () => 1),
          notJson: await schedule('* * * * *', {}, 'jobs', untyped('"abc"')),
          nul: await schedule('* * * * *', {}, 'jobs', { s: 'a\u0000b' }),
          loneHigh: await schedule('* * * * *', {}, 'jobs', { s: '\ud800' }),
          loneLow: await schedule('* * * * *', {}, 'jobs', { s: 'x\udc00' }),
          loneKey: await schedule('* * * * *', {}, 'jobs', { 'k\ud800': 1 }),
          loneNested: await schedule('* * * * *', {}, 'jobs', {
            a: [{ b: { c: '\ud83d' } }],
          }),
          twoHighs: await schedule('* * * * *', {}, 'jobs', {
            s: '\ud800\ud800',
          }),
          pair: await schedule('* * * * *', {}, 'jobs', { s: '\ud83d\ude00' }),
          highTextLow: await schedule('* * * * *', {}, 'jobs', {
            s: '\ud83dx\ude00',
          }),
          backslashText: await schedule('* * * * *', {}, 'jobs', {
            s: '\\ud800',
          }),
          escapedPrivateUseText: await schedule(
            '* * * * *',
            {},
            'jobs',
            untyped('"\\"\\\\ue000\\""'),
          ),
          escapedLoneText: await schedule(
            '* * * * *',
            {},
            'jobs',
            untyped('"\\"\\\\ud800\\""'),
          ),
          escapedPairText: await schedule(
            '* * * * *',
            {},
            'jobs',
            untyped('"\\"\\\\ud83d\\\\ude00\\""'),
          ),
          loneInOptions: await schedule('* * * * *', { custom: '\ud800' }),
          nulBeforeLone: await schedule('* * * * *', {}, 'jobs', {
            a: '\u0000',
            b: '\ud800',
          }),
          loneBeforeNul: await schedule('* * * * *', {}, 'jobs', {
            a: '\ud800',
            b: '\u0000',
          }),
          loneKeyBeforeNulValue: await schedule('* * * * *', {}, 'jobs', {
            '\ud800': '\u0000',
          }),
          nulKeyBeforeLoneValue: await schedule('* * * * *', {}, 'jobs', {
            '\u0000': '\ud800',
          }),
          nulFirstInAString: await schedule('* * * * *', {}, 'jobs', {
            a: 'x\u0000\ud800',
          }),
          loneFirstInAString: await schedule('* * * * *', {}, 'jobs', {
            a: 'x\udc00\u0000',
          }),
          loneFirstInAnArray: await schedule('* * * * *', {}, 'jobs', [
            '\ud800',
            '\u0000',
          ]),
          dataBeforeOptions: await schedule(
            '* * * * *',
            { custom: '\ud800' },
            'jobs',
            { a: '\u0000' },
          ),
        },
        name: {
          missingQueue: await schedule('* * * * *', {}, 'missing'),
          invalidName: await schedule('* * * * *', {}, 'bad name!'),
          empty: await schedule('* * * * *', {}, ''),
          number: await schedule('* * * * *', {}, untyped('5')),
          null: await schedule('* * * * *', {}, untyped('null')),
          undefinedCron: await outcome(() =>
            queue.schedule('jobs', untyped('{}').cron),
          ),
        },
        order: {
          cronBeforeMissingQueue: await schedule('not a cron', {}, 'missing'),
          cronBeforeEmptyName: await schedule('not a cron', {}, ''),
          rruleBeforeTimezone: await schedule('FREQ=DAILY;BYHOURS=9', {
            tz: 'Mars/Base',
          }),
          spentBeforeKey: await schedule('FREQ=DAILY;UNTIL=20200101T000000Z', {
            key: 'bad key!',
          }),
          timezoneBeforeKey: await schedule('* * * * *', {
            tz: 'Mars/Base',
            key: 'bad key!',
          }),
          sendOptionsBeforeKey: await schedule('* * * * *', {
            retryLimit: -1,
            key: 'bad key!',
          }),
          keyBeforeMissed: await schedule('* * * * *', {
            key: 'bad key!',
            missed: 'x',
          }),
          keyBeforeMissingQueue: await schedule(
            '* * * * *',
            { key: 'bad key!' },
            'missing',
          ),
          missedBeforeMissingQueue: await schedule(
            '* * * * *',
            { missed: 'x' },
            'missing',
          ),
        },
      };
    });

    // Timekeeper.schedule (node_modules/pg-boss/dist/timekeeper.js:812-849):
    // the expression (cron-parser, or rrule.js's checks), the zone, a rule's
    // remaining occurrences, checkSendArgs, assertKey, assertMissedPolicy,
    // then the upsert, whose foreign key names the queue (845-847).
    const rejects = (message: string) =>
      `AssertionError: ${message} (ERR_ASSERTION)`;
    const spent = rejects(
      'rrule expression has no occurrence left, so the schedule would never send a job',
    );
    const unknownZone = 'Error: Unknown or unsupported time zone: "Mars/Base"';
    const badKey = rejects(
      'Key can only contain alphanumeric characters, underscores, hyphens, periods, or forward slashes',
    );
    const missed = rejects('missed must be one of: skip, once');
    const noQueueName = rejects('boss requires all jobs to have a queue name');
    const invalidCharacters = 'Error: Invalid characters, got value: a';
    // jsonb's input refuses the first escape it cannot store, in text order:
    // \u0000, or a surrogate not paired high-then-low.
    const invalidJson = 'error: invalid input syntax for type json (22P02)';
    const unsupportedEscape =
      'error: unsupported Unicode escape sequence (22P05)';
    assert.deepStrictEqual(observed, {
      cron: {
        invalidCharacters,
        outOfRange: 'Error: Constraint error, got value 61 expected range 0-59',
        dayOutOfRange:
          'Error: Constraint error, got value 32 expected range 1-31',
        tooManyFields: 'Error: Invalid cron expression, too many fields',
        blank: 'Error: Invalid characters, got value: ',
        unknownAlias: 'Error: Validation error, cannot resolve alias "min"',
        number: 'TypeError: expression.trim is not a function',
        empty: 'resolved',
        seconds: 'resolved',
        alias: 'resolved',
        names: 'resolved',
        lastDay: 'resolved',
        nthWeekday: 'resolved',
        question: 'resolved',
      },
      rrule: {
        beginLine: rejects(
          'rrule expression should be the DTSTART, RRULE, RDATE and EXDATE lines of a calendar entry, without the BEGIN and END lines around them',
        ),
        endLine: rejects(
          'rrule expression should be the DTSTART, RRULE, RDATE and EXDATE lines of a calendar entry, without the BEGIN and END lines around them',
        ),
        property: rejects(
          'Unsupported property "SUMMARY" in rrule expression. Supported properties: DTSTART, RRULE, RDATE, EXDATE',
        ),
        twoDtstart: rejects('rrule expression has more than one DTSTART'),
        twoRrule: rejects('rrule expression has more than one RRULE'),
        noRrule: rejects('rrule expression has no RRULE to recur on'),
        countWithoutDtstart: rejects(
          'rrule expression uses COUNT, which counts occurrences from DTSTART, so it needs a DTSTART of its own',
        ),
        exdateType: rejects(
          'rrule EXDATE "20261224" must have the same value type as DTSTART: a date time such as 20261224T090000',
        ),
        rdateType: rejects(
          'rrule RDATE "20260105T090000" must have the same value type as DTSTART: a date such as 20260105',
        ),
        partWithoutValue: rejects('rrule part "BYHOUR" has no value'),
        unsupportedPart: rejects(
          'Unsupported part "BYHOURS=9" in rrule expression',
        ),
        duplicatePart: rejects(
          'rrule expression has more than one BYHOUR part',
        ),
        valueOutOfRange: rejects('Unsupported value in rrule part "BYHOUR=25"'),
        listValueOutOfRange: rejects(
          'Unsupported value in rrule part "BYHOUR=9,25"',
        ),
        strict: 'Error: BYMONTHDAY MUST NOT be used when FREQ is WEEKLY',
        badByday: 'Error: Invalid BYDAY value: XX',
        badWkst: 'Error: Invalid WKST value: XX',
        intervalZero:
          'Error: Cannot create RRule: interval must be greater than 0',
        noFreq: 'Error: RRULE must include FREQ',
        spentCount: spent,
        spentUntil: spent,
        extensionPart: 'resolved',
        lowercase: 'resolved',
        folded: 'resolved',
        crlf: 'resolved',
        blankLinesAndParts: 'resolved',
        zonedDtstart: 'resolved',
        rscale: 'resolved',
        until: 'resolved',
      },
      timezone: {
        unknown: unknownZone,
        number: 'Error: Unknown or unsupported time zone: 5',
        rrule: unknownZone,
        empty: 'resolved',
        null: 'resolved',
        named: 'resolved',
      },
      options: {
        missedUnknown: missed,
        missedNull: 'resolved',
        missedOnce: 'resolved',
        badKey,
        numberKey: rejects('Key must be a string'),
        nullKey:
          'error: null value in column "key" of relation "schedule" violates not-null constraint (23502)',
        badRetry: rejects('retryLimit must be an integer >= 0'),
        badPriority: rejects('priority must be an integer'),
        undefinedPriority: rejects('priority must be an integer'),
        nullOptions:
          "TypeError: Cannot destructure property 'tz' of 'options' as it is null.",
      },
      data: {
        function: rejects(
          'send() cannot accept a function as the payload.  Did you intend to use work()?',
        ),
        notJson: invalidJson,
        nul: unsupportedEscape,
        loneHigh: invalidJson,
        loneLow: invalidJson,
        loneKey: invalidJson,
        loneNested: invalidJson,
        twoHighs: invalidJson,
        pair: 'resolved',
        highTextLow: invalidJson,
        backslashText: 'resolved',
        escapedPrivateUseText: 'resolved',
        escapedLoneText: invalidJson,
        escapedPairText: 'resolved',
        loneInOptions: invalidJson,
        nulBeforeLone: unsupportedEscape,
        loneBeforeNul: invalidJson,
        loneKeyBeforeNulValue: invalidJson,
        nulKeyBeforeLoneValue: unsupportedEscape,
        nulFirstInAString: unsupportedEscape,
        loneFirstInAString: invalidJson,
        loneFirstInAnArray: invalidJson,
        dataBeforeOptions: unsupportedEscape,
      },
      name: {
        missingQueue: 'error: Queue missing not found (23503)',
        invalidName: 'error: Queue bad name! not found (23503)',
        empty: noQueueName,
        number: noQueueName,
        null: rejects('send object API only accepts 1 argument'),
        undefinedCron:
          'error: null value in column "cron" of relation "schedule" violates not-null constraint (23502)',
      },
      order: {
        cronBeforeMissingQueue: invalidCharacters,
        cronBeforeEmptyName: invalidCharacters,
        rruleBeforeTimezone: rejects(
          'Unsupported part "BYHOURS=9" in rrule expression',
        ),
        spentBeforeKey: spent,
        timezoneBeforeKey: unknownZone,
        sendOptionsBeforeKey: rejects('retryLimit must be an integer >= 0'),
        keyBeforeMissed: badKey,
        keyBeforeMissingQueue: badKey,
        missedBeforeMissingQueue: missed,
      },
    });
  });

  it("judges whether a rule has an occurrence left from the clock, in the schedule's zone", async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      const everyMinuteUntil = 'FREQ=MINUTELY;UNTIL=20260101T000100Z';
      const atStart = await outcome(() =>
        queue.schedule('jobs', everyMinuteUntil, null, { key: 'a' }),
      );
      await clock.tick(60000);
      const aMinuteLater = await outcome(() =>
        queue.schedule('jobs', everyMinuteUntil, null, { key: 'b' }),
      );
      // Noon on 2026-01-01 is still ahead in UTC and already past in UTC+14.
      const untilNoon = 'FREQ=HOURLY;UNTIL=20260101T120000';
      const inUtc = await outcome(() =>
        queue.schedule('jobs', untilNoon, null, { key: 'c' }),
      );
      const inKiritimati = await outcome(() =>
        queue.schedule('jobs', untilNoon, null, {
          key: 'd',
          tz: 'Pacific/Kiritimati',
        }),
      );
      return { atStart, aMinuteLater, inUtc, inKiritimati };
    });

    // assertRruleSends reads the first occurrence after the database's time
    // in the schedule's own zone (timekeeper.js:834, rrule.js:232-235,
    // 382-384); SQLite's database time is the clock's.
    const spent =
      'AssertionError: rrule expression has no occurrence left, so the schedule would never send a job (ERR_ASSERTION)';
    assert.deepStrictEqual(observed, {
      atStart: 'resolved',
      aMinuteLater: spent,
      inUtc: 'resolved',
      inKiritimati: spent,
    });
  });

  it('stores the schedule as given: kind, zone, data and the full options, an upsert keeping created_on', async () => {
    const observed = await Parity.assertSame(async (run) => {
      const { queue, clock } = run;
      await queue.start();
      await queue.createQueue('jobs');
      await queue.schedule('jobs', '* * * * *');
      await queue.schedule(
        'jobs',
        'FREQ=MINUTELY;INTERVAL=2',
        { a: 1 },
        {
          key: 'rule',
          tz: 'Asia/Kolkata',
          missed: 'once',
          singletonKey: 's',
          priority: 3,
          retryLimit: 5,
          startAfter: new Date(Date.parse(ParityRun.start) + 5000),
        },
      );
      await queue.schedule(
        'jobs',
        '0 * * * *',
        untyped('5'),
        untyped('{"key":0,"missed":null}'),
      );
      await queue.schedule(
        'jobs',
        '0 * * * *',
        untyped('"{\\"x\\":1}"'),
        untyped('{"key":false,"tz":""}'),
      );
      await queue.schedule(
        'jobs',
        '0 9 * * *',
        { b: 2 },
        {
          key: 'upsert',
          tz: 'Europe/London',
        },
      );
      const stored = await schedules(run);
      await clock.tick(1500);
      await queue.schedule(
        'jobs',
        'FREQ=DAILY;BYHOUR=9',
        undefined,
        untyped('{"key":"upsert","tz":null}'),
      );
      const upserted = (await schedules(run)).filter(
        (row) => row.key === 'upsert',
      );
      return { stored, upserted };
    });

    // timekeeper.js:815-817, 836-841 and plans.js:358-374, 1337-1349: the
    // zone defaults to UTC, the kind is read off the expression, a key keeps
    // the driver's text of a falsy non-string, data is jsonb (a string is
    // JSON text), and the options are stored whole, tz, key and missed
    // included, as the caller passed them.
    const row = (fields: Record<string, unknown>) => ({
      name: 'jobs',
      kind: 'cron',
      timezone: 'UTC',
      data: null,
      created_on: 0,
      updated_on: 0,
      ...fields,
    });
    assert.deepStrictEqual(observed, {
      stored: [
        row({ key: '', cron: '* * * * *', options: {} }),
        row({
          key: '0',
          cron: '0 * * * *',
          data: 5,
          options: { key: 0, missed: null },
        }),
        row({
          key: 'false',
          cron: '0 * * * *',
          data: { x: 1 },
          options: { key: false, tz: '' },
        }),
        row({
          key: 'rule',
          kind: 'rrule',
          cron: 'FREQ=MINUTELY;INTERVAL=2',
          timezone: 'Asia/Kolkata',
          data: { a: 1 },
          options: {
            key: 'rule',
            tz: 'Asia/Kolkata',
            missed: 'once',
            singletonKey: 's',
            priority: 3,
            retryLimit: 5,
            startAfter: '2026-01-01T00:00:05.000Z',
          },
        }),
        row({
          key: 'upsert',
          cron: '0 9 * * *',
          timezone: 'Europe/London',
          data: { b: 2 },
          options: { key: 'upsert', tz: 'Europe/London' },
        }),
      ],
      upserted: [
        row({
          key: 'upsert',
          kind: 'rrule',
          cron: 'FREQ=DAILY;BYHOUR=9',
          options: { key: 'upsert', tz: null },
          updated_on: 1500,
        }),
      ],
    });
  });

  it("stores data and options as the oracle's driver serializes them", async () => {
    const observed = await Parity.assertSame(async (run) => {
      const { queue } = run;
      await queue.start();
      await queue.createQueue('jobs');
      const cases: Array<[string, object | null, Record<string, unknown>]> = [
        ['bigint', { a: 1n, b: [2n] }, { custom: 3n }],
        ['date', new Date(0), {}],
        ['buffer', Buffer.from('ab'), {}],
        ['bytes', new Uint8Array([1, 2]), {}],
        ['nan', [Number.NaN], {}],
        ['array', [1, 'a', null, { b: true }], {}],
        // JSON text holding a raw lone surrogate.
        ['rawLone', untyped('"\\"\\ud800\\""'), {}],
        [
          'nested',
          null,
          {
            group: { id: 'g', tier: 't' },
            deadLetter: 'dl',
            singletonKey: undefined,
            custom: undefined,
          },
        ],
        ['k'.repeat(5000), null, {}],
        ['a__b', null, {}],
      ];
      for (const [key, data, options] of cases) {
        await queue.schedule('jobs', '* * * * *', data, {
          key,
          ...options,
        });
      }
      return (await schedules(run)).map(({ key, data, options }) => ({
        key: key.length > 100 ? `k x ${key.length}` : key,
        data,
        options:
          key.length > 100 ? { ...options, key: `k x ${key.length}` } : options,
      }));
    });

    // PGlite's json serializer passes a string through and stringifies
    // anything else with a bigint as its string (@electric-sql/pglite 0.5.8
    // src/types.ts:106-114); the text travels as UTF-8, so a raw lone
    // surrogate arrives as U+FFFD. An undefined option is left out of the
    // stored options.
    assert.deepStrictEqual(observed, [
      { key: 'a__b', data: null, options: { key: 'a__b' } },
      {
        key: 'array',
        data: [1, 'a', null, { b: true }],
        options: { key: 'array' },
      },
      {
        key: 'bigint',
        data: { a: '1', b: ['2'] },
        options: { key: 'bigint', custom: '3' },
      },
      {
        key: 'buffer',
        data: { type: 'Buffer', data: [97, 98] },
        options: { key: 'buffer' },
      },
      { key: 'bytes', data: { 0: 1, 1: 2 }, options: { key: 'bytes' } },
      {
        key: 'date',
        data: '1970-01-01T00:00:00.000Z',
        options: { key: 'date' },
      },
      { key: 'k x 5000', data: null, options: { key: 'k x 5000' } },
      { key: 'nan', data: [null], options: { key: 'nan' } },
      {
        key: 'nested',
        data: null,
        options: {
          key: 'nested',
          group: { id: 'g', tier: 't' },
          deadLetter: 'dl',
        },
      },
      { key: 'rawLone', data: '\ufffd', options: { key: 'rawLone' } },
    ]);
  });

  it('judges a remaining occurrence exclusively at the clock, at UNTIL, COUNT, a DST gap and a zoned DTSTART', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      let n = 0;
      const schedule = (cron: string, tz?: string) =>
        outcome(() =>
          queue.schedule('jobs', cron, null, {
            key: `k${n++}`,
            ...(tz === undefined ? {} : { tz }),
          }),
        );
      const at = (iso: string) => clock.setTime(Date.parse(iso));
      const until = 'FREQ=SECONDLY;UNTIL=20260101T000010Z';
      const count = 'DTSTART:20260101T000010Z\nRRULE:FREQ=DAILY;COUNT=1';
      // 16:00 in Tokyo is 07:00Z; 02:30 does not exist in New York on
      // 2026-03-08 and resolves to 03:30 EDT, 07:30Z.
      const tokyo =
        'DTSTART;TZID=Asia/Tokyo:20260308T160000\nRRULE:FREQ=DAILY;COUNT=1';
      const gap = 'DTSTART:20260308T023000\nRRULE:FREQ=DAILY;COUNT=1';
      const york = 'America/New_York';
      await at('2026-01-01T00:00:09.999Z');
      const before = {
        until: await schedule(until),
        count: await schedule(count),
      };
      await at('2026-01-01T00:00:10.000Z');
      const exactly = {
        until: await schedule(until),
        count: await schedule(count),
      };
      await at('2026-01-01T00:00:10.001Z');
      const after = { until: await schedule(until) };
      await at('2026-03-08T06:59:59.999Z');
      const beforeTokyo = await schedule(tokyo, york);
      await at('2026-03-08T07:00:00.000Z');
      const atTokyo = await schedule(tokyo, york);
      await at('2026-03-08T07:29:59.999Z');
      const beforeGap = await schedule(gap, york);
      await at('2026-03-08T07:30:00.000Z');
      const atGap = await schedule(gap, york);
      return {
        before,
        exactly,
        after,
        beforeTokyo,
        atTokyo,
        beforeGap,
        atGap,
      };
    });

    // rrule.js:232-235 asks for the first occurrence strictly after the
    // database's time (next() without inc), DTSTART's own zone winning over
    // the schedule's.
    const spent =
      'AssertionError: rrule expression has no occurrence left, so the schedule would never send a job (ERR_ASSERTION)';
    assert.deepStrictEqual(observed, {
      before: { until: 'resolved', count: 'resolved' },
      exactly: { until: spent, count: spent },
      after: { until: spent },
      beforeTokyo: 'resolved',
      atTokyo: spent,
      beforeGap: 'resolved',
      atGap: spent,
    });
  });

  it('unschedules one name and key without validating either; deleting a queue drops its schedules', async () => {
    const observed = await Parity.assertSame(async (run) => {
      const { queue } = run;
      await queue.start();
      for (const name of ['jobs', 'other']) {
        await queue.createQueue(name);
      }
      for (const key of ['', 'a', 'b', untyped('0'), untyped('false')]) {
        await queue.schedule('jobs', '* * * * *', null, { key });
      }
      await queue.schedule('other', '* * * * *');
      const keys = async () =>
        (await schedules(run)).map((row) => `${row.name}/${row.key}`);
      const results = {
        defaultKey: await outcome(() => queue.unschedule('jobs')),
        nullKey: await outcome(() => queue.unschedule('jobs', untyped('null'))),
        missingQueue: await outcome(() => queue.unschedule('missing', 'x')),
        invalidName: await outcome(() => queue.unschedule('bad name!', 'a')),
        nullName: await outcome(() => queue.unschedule(untyped('null'))),
        named: await outcome(() => queue.unschedule('jobs', 'b')),
        numberKey: await outcome(() => queue.unschedule('jobs', untyped('0'))),
        booleanKey: await outcome(() =>
          queue.unschedule('jobs', untyped('false')),
        ),
      };
      const afterUnschedule = await keys();
      await queue.deleteQueue('other');
      return { results, afterUnschedule, afterDelete: await keys() };
    });

    // timekeeper.js:850-853, plans.js:1350-1356, the key bound as text as
    // schedule() stores it; the schedule's foreign key cascades
    // (plans.js:360).
    assert.deepStrictEqual(observed, {
      results: {
        defaultKey: 'resolved',
        nullKey: 'resolved',
        missingQueue: 'resolved',
        invalidName: 'resolved',
        nullName: 'resolved',
        named: 'resolved',
        numberKey: 'resolved',
        booleanKey: 'resolved',
      },
      afterUnschedule: ['jobs/a', 'other/'],
      afterDelete: ['jobs/a'],
    });
  });
});
