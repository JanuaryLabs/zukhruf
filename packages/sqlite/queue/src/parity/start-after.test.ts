import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SqliteJobQueue, UnsupportedStartAfterError } from '../index.ts';
import { PgBossBackend } from './backends.ts';
import { Observe } from './observe.ts';
import { Parity } from './parity.ts';

// Each form is sent as its own job; the stored startAfter is read back as
// milliseconds since the shared clock's origin.
const forms: Record<string, Date | number | string> = {
  date: new Date('2026-03-01T00:00:00.000Z'),
  seconds: 300,
  secondsZero: 0,
  secondsNegative: -5,
  secondsString: '300',
  secondsStringNegative: '-5',
  secondsStringFraction: '1.5',
  isoDate: '2027-01-01',
  isoZoneless: '2027-01-01T08:00:00',
  isoZonelessSpace: '2027-01-01 08:00',
  isoUtc: '2027-01-01T08:00:00Z',
  isoOffset: '2027-01-01T08:00:00+05:30',
  isoOffsetHours: '2027-01-01T08:00:00+05',
  isoOffsetCompact: '2027-01-01T08:00:00+0530',
  isoOffsetNegative: '2027-01-01T08:00:00-0800',
  isoFraction: '2027-01-01T08:00:00.123Z',
  isoZonelessFraction: '2027-01-01T08:00:00.5',
  isoDurationMinutes: 'PT5M',
  isoDurationDayHours: 'P1DT2H',
  isoDurationWeek: 'P1W',
  isoDurationFull: 'P1Y2M3DT4H5M6S',
  minutes: '5 minutes',
  dayAndHours: '1 day 2 hours',
  weeks: '2 weeks',
  months: '3 mons',
  year: '1 year',
  secondsUnit: '90 seconds',
  aliases: '1 hr 2 mins 3 sec 1 yr',
  upperCase: '2 HOURS',
  monthsAndDays: '1 mon 2 days',
  compact: '5minutes',
};

describe('startAfter', () => {
  it('resolves every supported form to the instant pg-boss stores', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      const at = async (form: Date | number | string, n: number) => {
        const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
        await queue.send('jobs', { n }, { id, startAfter: form });
        const [job] = await queue.findJobs('jobs', { id });
        assert.ok(job, `job ${n} was not stored`);
        return Observe.job(job).startAfter;
      };

      const results: Record<string, unknown> = {};
      let n = 0;
      for (const [label, form] of Object.entries(forms)) {
        results[label] = await at(form, ++n);
      }
      // Values that mean "now" in pg-boss, arriving untyped.
      results.nullValue = await at(JSON.parse('null'), ++n);
      results.falseValue = await at(JSON.parse('false'), ++n);
      results.emptyArray = await at(JSON.parse('[]'), ++n);
      // Calendar months clamp to the end of a shorter month.
      await clock.setTime('2026-01-31T10:00:00.000Z');
      results.monthFromJanuary31 = await at('1 month', n + 1);
      return results;
    });

    assert.equal(observed.seconds, 300_000);
    assert.equal(observed.secondsZero, 0);
    assert.equal(observed.secondsNegative, 0);
    assert.equal(observed.nullValue, 0);
    assert.equal(observed.falseValue, 0);
    assert.equal(observed.emptyArray, 0);
    assert.equal(
      observed.isoUtc,
      Date.parse('2027-01-01T08:00:00Z') - Date.parse('2026-01-01T00:00:00Z'),
    );
  });

  // The cited subset: forms outside it go to Postgres's interval and timestamp
  // grammar in pg-boss, which SQLite does not reimplement, so it refuses them
  // by name instead of guessing (plan ruling, 2026-10-02). Each is first shown
  // to be one pg-boss accepts, so the refusal is SQLite's alone.
  it('refuses forms outside the supported subset by name', async () => {
    const refused = [
      '1 day ago',
      '@ 1 hour',
      '1.5 hours',
      '1-2',
      '01:02:03',
      '2027-01-01 08:00:00 America/New_York',
    ];
    // Postgres rejects these timestamps (a comma decimal, an hour with no
    // minutes), so pg-boss throws on them as well; SQLite must refuse them
    // rather than be more lenient.
    const rejectedByBoth = ['2027-01-01T08:00:00,123Z', '2027-01-01T08'];

    const pgBoss = await new PgBossBackend().open();
    try {
      await pgBoss.queue.start();
      await pgBoss.queue.createQueue('jobs');
      for (const form of rejectedByBoth) {
        await assert.rejects(
          pgBoss.queue.send('jobs', { n: 1 }, { startAfter: form }),
          form,
        );
      }
      for (const form of refused) {
        assert.ok(
          await pgBoss.queue.send('jobs', { n: 1 }, { startAfter: form }),
          `pg-boss accepts ${form}`,
        );
      }
    } finally {
      await pgBoss.close();
    }

    const queue = new SqliteJobQueue({ path: ':memory:', schedule: false });
    try {
      await queue.start();
      await queue.createQueue('jobs');
      for (const form of [...refused, ...rejectedByBoth]) {
        await assert.rejects(
          queue.send('jobs', { n: 1 }, { startAfter: form }),
          (error) =>
            error instanceof UnsupportedStartAfterError &&
            error.startAfter === form,
          form,
        );
      }
    } finally {
      await queue.stop({ graceful: false, close: true });
    }
  });
});
