import assert from 'node:assert';

import { CronExpressionParser } from 'cron-parser';
import { scheduleMissedPolicies } from 'pg-boss';
import { RRuleTemporal } from 'rrule-temporal';

// pg-boss's checks on a schedule's recurrence (node_modules/pg-boss/dist/
// rrule.js, timezone.js and timekeeper.js, 12.35.1). None of them is
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
  // timekeeper.js:48
  static readonly #missedPolicies: readonly unknown[] = Object.values(
    scheduleMissedPolicies,
  );

  // rrule.js:65-67
  static isRrule(expression: string): boolean {
    return Recurrence.#rruleShape.test(expression);
  }

  // timekeeper.js:185-194. parseRecurrence's walk (176-180) is for
  // previewSchedule, so only its two checks are kept.
  static assertRecurrence(expression: string, tz: string): void {
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
      CronExpressionParser.parse('* * * * *', {
        tz,
        strict: false,
        currentDate: new Date(),
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

  // timekeeper.js:156-163
  static assertMissedPolicy(missed: unknown): void {
    assert(
      missed === undefined ||
        missed === null ||
        Recurrence.#missedPolicies.includes(missed),
      `missed must be one of: ${Recurrence.#missedPolicies.join(', ')}`,
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

  // rrule.js:221-223
  static #parseRule(expression: string, tz: string): RRuleTemporal {
    return Recurrence.#buildRule(Recurrence.#toIcs(expression).ics, tz);
  }
}
