import assert from 'node:assert';

import {
  CronDate,
  type CronExpression,
  CronExpressionParser,
} from 'cron-parser';
import { scheduleMissedPolicies, schedulePrecisions } from 'pg-boss';
import { RRuleTemporal } from 'rrule-temporal';

// pg-boss's checks on a schedule's recurrence (node_modules/pg-boss/dist/
// rrule.js, timezone.js and timekeeper.js, 12.39.0). None of them is
// exported, so each is ported by citation and proven equal by the parity
// suite.
export class Recurrence {
  // rrule.js:17
  static readonly #epochDtstart = '19700101T000000';
  // rrule.js:23
  static readonly #properties = new Set([
    'DTSTART',
    'RRULE',
    'RDATE',
    'EXDATE',
  ]);
  // rrule.js:33-50
  static readonly #partOptions = new Map([
    ['FREQ', 'freq'],
    ['UNTIL', 'until'],
    ['COUNT', 'count'],
    ['INTERVAL', 'interval'],
    ['BYSECOND', 'bySecond'],
    ['BYMINUTE', 'byMinute'],
    ['BYHOUR', 'byHour'],
    ['BYDAY', 'byDay'],
    ['BYMONTHDAY', 'byMonthDay'],
    ['BYYEARDAY', 'byYearDay'],
    ['BYWEEKNO', 'byWeekNo'],
    ['BYMONTH', 'byMonth'],
    ['BYSETPOS', 'bySetPos'],
    ['WKST', 'wkst'],
    ['RSCALE', 'rscale'],
    ['SKIP', 'skip'],
  ]);
  // rrule.js:52
  static readonly #property = /^([a-z][a-z0-9-]*)[;:]/i;
  // rrule.js:63
  static readonly #rruleShape = /^[ \t]*[a-z][a-z0-9-]*[;:]|(?:^|[\s;])FREQ=/im;
  // rrule.js:290-291
  static readonly #stepSeconds = 60 * 60;
  static readonly #stepGrowth = 4;
  // timekeeper.js:52
  static readonly #missedPolicies: readonly unknown[] = Object.values(
    scheduleMissedPolicies,
  );

  // timekeeper.js:53
  static readonly #precisions: readonly unknown[] =
    Object.values(schedulePrecisions);

  // timekeeper.js:86-133 (12.39.0): whether a schedule is sent every second,
  // for each occurrence, rather than by the pass a job a minute. Opt-in, so a
  // stored `* * * * * *` keeps its job a minute; read off the parsed seconds
  // field, so `@secondly` is every second and a seconds field of 0 stays with
  // the pass. An expression that does not parse stays with the pass too.
  static isSecondCron(expression: string, options: unknown): boolean {
    const precision =
      typeof options === 'object' && options !== null && 'precision' in options
        ? options.precision
        : undefined;
    if (precision !== schedulePrecisions.second) {
      return false;
    }
    try {
      const seconds = CronExpressionParser.parse(expression, { strict: false })
        .fields.second.values;
      return !(seconds.length === 1 && seconds[0] === 0);
    } catch {
      return false;
    }
  }

  // timekeeper.js:114-132 (12.39.0): every occurrence in (after, until], oldest
  // first, each second asked about, and the second instant of a repeated
  // local time passed over as previousOccurrence passes it over.
  static cronOccurrencesBetween(
    interval: CronExpression,
    tz: string,
    after: number,
    until: number,
  ): Date[] {
    const found: Date[] = [];
    for (
      let second = Math.floor(after / 1000) + 1;
      second * 1000 <= until;
      second++
    ) {
      const instant = new Date(second * 1000);
      if (
        interval.includesDate(instant) &&
        !Recurrence.#passedOver(interval, instant, tz)
      ) {
        found.push(instant);
      }
    }
    return found;
  }

  // timekeeper.js:173-184 (12.39.0, #1007): an occurrence a repeated local
  // time holds no job for, in an expression that names neither every hour
  // nor multiple minutes across multiple hours, which is a run rather than a
  // time of day and keeps both instants.
  static #passedOver(
    interval: CronExpression,
    instant: Date,
    tz: string,
  ): boolean {
    const { hour, minute } = interval.fields;
    const keepsRepeatedHour =
      hour.values.length === 24 ||
      (hour.values.length > 1 && minute.values.length > 1);
    return !keepsRepeatedHour && Recurrence.#repeatsLocalTime(instant, tz);
  }

  // timekeeper.js:133-152 (12.39.0): the latest occurrence before an
  // interval's reference, read backwards the way the forward walk reads
  // forwards. When the clocks go back, a local time shows twice, and prev()
  // answers with both instants an hour apart, so a daily job would be sent
  // twice; the second is passed over as #passedOver says.
  static previousOccurrence(interval: CronExpression, tz: string): Date {
    for (;;) {
      const occurrence = interval.prev().toDate();
      if (!Recurrence.#passedOver(interval, occurrence, tz)) {
        return occurrence;
      }
    }
  }

  // timekeeper.js:153-172 (12.39.0): the latest occurrence in (after, until],
  // walking forwards, for a range prev() cannot read back across. The
  // forward walk moves a skipped time's occurrence into the hour the clocks
  // landed on, which the expression does not name, so includesDate leaves
  // it out as the backward read does.
  static latestOccurrenceForward(
    expression: string,
    tz: string,
    after: number,
    until: number,
  ): Date | null {
    const interval = CronExpressionParser.parse(expression, {
      tz,
      strict: false,
      currentDate: new Date(after),
    });
    let latest: Date | null = null;
    for (;;) {
      const occurrence = interval.next().toDate();
      if (occurrence.getTime() > until) {
        return latest;
      }
      if (
        interval.includesDate(occurrence) &&
        !Recurrence.#passedOver(interval, occurrence, tz)
      ) {
        latest = occurrence;
      }
    }
  }

  // timekeeper.js:184-195: whether the local time an instant shows in `tz`
  // was already shown once, before the clocks went back. The offset three
  // hours before is the one in force before any change the instant could be
  // repeating, since no zone goes back by more than two.
  static #repeatsLocalTime(instant: Date, tz: string): boolean {
    const offset = (time: number) => new CronDate(time, tz).getUTCOffset();
    const time = instant.getTime();
    const shift = offset(time - 3 * 60 * 60 * 1000) - offset(time);
    return (
      shift > 0 && offset(time - shift * 60 * 1000) - offset(time) === shift
    );
  }

  // timekeeper.js:308-313 (12.37.0): cron-parser reads an empty expression,
  // and undefined or null, as `* * * * *`, which is nearly always a missing
  // value, so schedule() and each pass refuse it before either format reads
  // it.
  static assertExpression(expression: unknown): asserts expression is string {
    assert(
      typeof expression === 'string' && expression.trim() !== '',
      'cron expression must be a non-empty string',
    );
  }

  // rrule.js:65-67
  static isRrule(expression: string): boolean {
    return Recurrence.#rruleShape.test(expression);
  }

  // timekeeper.js:303-325. parseRecurrence's walk is for previewSchedule, so
  // only its two checks are kept. cron-parser reads an empty expression, and
  // undefined or null, as `* * * * *`, so a non-string or blank one is refused
  // before either format reads it (12.37.0: 213-218).
  static assertRecurrence(expression: unknown, tz: string): void {
    Recurrence.assertExpression(expression);
    if (Recurrence.isRrule(expression)) {
      Recurrence.#assertRrule(expression, tz);
    } else {
      CronExpressionParser.parse(expression, { tz: 'UTC', strict: false });
      Recurrence.assertTimezone(tz);
    }
  }

  // timezone.js:18-33
  static assertTimezone(tz: unknown): void {
    const unusable = `Unknown or unsupported time zone: ${typeof tz === 'string' ? `"${tz}"` : String(tz)}`;
    if (typeof tz !== 'string') {
      throw new Error(unusable);
    }
    try {
      // Only the time zone is checked, so any fixed date serves.
      CronExpressionParser.parse('* * * * *', {
        tz,
        strict: false,
        currentDate: new Date(0),
      });
    } catch {
      throw new Error(unusable);
    }
  }

  // rrule.js:382-384
  static assertRruleSends(expression: string, tz: string, from: Date): void {
    assert(
      Recurrence.#parseRule(expression, tz).next(from) !== null,
      'rrule expression has no occurrence left, so the schedule would never send a job',
    );
  }

  // timekeeper.js:278-290
  static assertMissedPolicy(missed: unknown): void {
    assert(
      missed === undefined ||
        missed === null ||
        Recurrence.#missedPolicies.includes(missed),
      `missed must be one of: ${Recurrence.#missedPolicies.join(', ')}`,
    );
  }

  // timekeeper.js:285-289 (12.39.0): nullish is the default, minute.
  static assertPrecision(precision: unknown): void {
    assert(
      precision === undefined ||
        precision === null ||
        Recurrence.#precisions.includes(precision),
      `precision must be one of: ${Recurrence.#precisions.join(', ')}`,
    );
  }

  // rrule.js:359-370
  static #assertRrule(expression: string, tz: string): void {
    const { ics, rule } = Recurrence.#toIcs(expression);
    Recurrence.#assertValues(rule, Recurrence.#buildRule(ics, 'UTC'));
    Recurrence.assertTimezone(tz);
  }

  // rrule.js:76-131
  static #toIcs(expression: string): { ics: string; rule: string } {
    const lines: string[] = [];
    const dates: Array<[string, string]> = [];
    let dtstart: string | null = null;
    let rule: string | null = null;
    for (const line of expression.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
      const text = line.trim();
      if (text.length === 0) {
        continue;
      }
      const property = Recurrence.#property.exec(text)?.[1]?.toUpperCase();
      const name = property || 'RRULE';
      const value = property ? text.slice(text.indexOf(':') + 1) : text;
      assert(
        name !== 'BEGIN' && name !== 'END',
        'rrule expression should be the DTSTART, RRULE, RDATE and EXDATE lines of a calendar entry, without the BEGIN and END lines around them',
      );
      assert(
        Recurrence.#properties.has(name),
        `Unsupported property "${name}" in rrule expression. Supported properties: ${[...Recurrence.#properties].join(', ')}`,
      );
      if (name === 'DTSTART') {
        assert(dtstart === null, 'rrule expression has more than one DTSTART');
        dtstart = value;
      }
      if (name === 'RRULE') {
        assert(rule === null, 'rrule expression has more than one RRULE');
        rule = value;
        Recurrence.#assertParts(value);
      }
      if (name === 'RDATE' || name === 'EXDATE') {
        dates.push([name, value]);
      }
      lines.push(property ? text : `RRULE:${text}`);
    }
    assert(rule !== null, 'rrule expression has no RRULE to recur on');
    if (dtstart === null) {
      assert(
        !/(^|;)COUNT=/i.test(rule),
        'rrule expression uses COUNT, which counts occurrences from DTSTART, so it needs a DTSTART of its own',
      );
      lines.unshift(`DTSTART:${Recurrence.#epochDtstart}`);
    }
    Recurrence.#assertDates(dates, dtstart ?? Recurrence.#epochDtstart);
    return { ics: lines.join('\n'), rule };
  }

  // rrule.js:134-155
  static #assertParts(rule: string): void {
    const named = new Set<string>();
    for (const part of rule.split(';')) {
      if (part.length === 0) {
        continue;
      }
      const [name = '', value = ''] = part.toUpperCase().split('=');
      assert(value.length > 0, `rrule part "${part}" has no value`);
      assert(
        Recurrence.#partOptions.has(name) || name.startsWith('X-'),
        `Unsupported part "${part}" in rrule expression`,
      );
      assert(
        !named.has(name),
        `rrule expression has more than one ${name} part`,
      );
      named.add(name);
    }
  }

  // rrule.js:162-175
  static #assertDates(
    dates: ReadonlyArray<[string, string]>,
    dtstart: string,
  ): void {
    const dtstartIsDate = !dtstart.includes('T');
    for (const [name, value] of dates) {
      for (const date of value.split(',')) {
        const expected = dtstartIsDate
          ? `a date such as ${date.slice(0, 8)}`
          : `a date time such as ${date}T090000`;
        assert(
          date.includes('T') !== dtstartIsDate,
          `rrule ${name} "${date}" must have the same value type as DTSTART: ${expected}`,
        );
      }
    }
  }

  // rrule.js:184-203
  static #assertValues(rule: string, built: RRuleTemporal): void {
    const options = new Map(Object.entries({ ...built.options() }));
    for (const part of rule.split(';')) {
      const [name = '', value = ''] = part.split('=');
      const option = Recurrence.#partOptions.get(name.toUpperCase());
      if (option === undefined) {
        continue;
      }
      const parsed = options.get(option);
      const message = `Unsupported value in rrule part "${part}"`;
      assert(parsed !== undefined, message);
      if (Array.isArray(parsed)) {
        assert(
          parsed.length === new Set(value.toUpperCase().split(',')).size,
          message,
        );
      }
    }
  }

  // rrule.js:205-211
  static #buildRule(ics: string, tz: string): RRuleTemporal {
    return new RRuleTemporal({ rruleString: ics, tzid: tz, strict: true });
  }

  // rrule.js:268-274, 281: every occurrence in (after, until], in order. between()
  // excludes both ends, so the upper one is nudged past.
  static occurrencesInWindow(
    expression: string,
    after: Date,
    until: Date,
    tz: string,
  ): Date[] {
    return Recurrence.#parseRule(expression, tz)
      .between(after, new Date(until.getTime() + 1))
      .map((occurrence) => new Date(occurrence.epochMilliseconds));
  }

  // rrule.js:323-356: the latest occurrence in (after, until], read in steps
  // that widen backwards from `until`. A step rrule-temporal refuses as too
  // dense is halved and read again, and its width caps every later step; one
  // refused at the floor is the expression's own fault, so it throws.
  static latestOccurrenceBefore(
    expression: string,
    after: Date,
    until: Date,
    tz: string,
  ): Date | null {
    const rule = Recurrence.#parseRule(expression, tz);
    const floor = Recurrence.#stepSeconds * 1000;
    const start = after.getTime();
    let upper = until.getTime();
    let width = floor;
    let ceiling = Number.POSITIVE_INFINITY;
    while (upper > start) {
      const lower = Math.max(start, upper - width);
      let step;
      try {
        step = rule.between(new Date(lower), new Date(upper + 1));
      } catch (error) {
        if (upper - lower <= floor) {
          throw error;
        }
        ceiling = Math.max(floor, Math.floor((upper - lower) / 2));
        width = ceiling;
        continue;
      }
      const latest = step.at(-1);
      if (latest !== undefined) {
        return new Date(latest.epochMilliseconds);
      }
      upper = lower;
      width = Math.min(width * Recurrence.#stepGrowth, ceiling);
    }
    return null;
  }

  // rrule.js:221-223
  static #parseRule(expression: string, tz: string): RRuleTemporal {
    return Recurrence.#buildRule(Recurrence.#toIcs(expression).ics, tz);
  }
}
