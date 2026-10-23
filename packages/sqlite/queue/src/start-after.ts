// A startAfter string pg-boss would hand to Postgres's own timestamp or
// interval grammar, outside the subset this queue resolves itself.
export class UnsupportedStartAfterError extends Error {
  override name = 'UnsupportedStartAfterError';
  readonly startAfter: string;

  constructor(startAfter: string) {
    super(
      `startAfter "${startAfter}" is outside the supported forms: a Date, seconds, an ISO 8601 date time or duration, or Postgres interval units with integer amounts`,
    );
    this.startAfter = startAfter;
  }
}

type Interval = {
  months: number;
  days: number;
  milliseconds: number;
};

// pg-boss normalizes startAfter in Attorney.checkSendArgs
// (node_modules/pg-boss/dist/attorney.js:108-116, 140-146), then casts a
// date time string as timestamptz and anything else as an interval added to
// now (plans.js:2228-2230, 2299-2302). This resolves the same normalization
// and a cited subset of what Postgres then parses; every supported form is
// proven equal to pg-boss in the parity suite (src/parity).
export class StartAfter {
  static readonly #isoDate = /^\d{4}-\d{2}-\d{2}/;
  static readonly #zonelessTime =
    /^(?:[T ]\d{2}(?::\d{2}(?::\d{2}(?:[.,]\d+)?)?)?)?$/;
  static readonly #dateTime =
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)$/;
  static readonly #seconds = /^[+-]?\d+(?:\.\d+)?$/;
  static readonly #isoDuration =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
  static readonly #unitsShape = /^(?:\d+\s*[a-z]+\s*)+$/i;
  static readonly #unitPairs = /(\d+)\s*([a-z]+)/gi;
  // Postgres interval units with integer amounts, as the field they add to.
  static readonly #unitScales = new Map<
    string,
    { field: keyof Interval; size: number }
  >([
    ...(['second', 'seconds', 'sec', 'secs'] as const).map(
      (unit) => [unit, { field: 'milliseconds', size: 1000 }] as const,
    ),
    ...(['minute', 'minutes', 'min', 'mins'] as const).map(
      (unit) => [unit, { field: 'milliseconds', size: 60_000 }] as const,
    ),
    ...(['hour', 'hours', 'hr', 'hrs'] as const).map(
      (unit) => [unit, { field: 'milliseconds', size: 3_600_000 }] as const,
    ),
    ...(['day', 'days'] as const).map(
      (unit) => [unit, { field: 'days', size: 1 }] as const,
    ),
    ...(['week', 'weeks'] as const).map(
      (unit) => [unit, { field: 'days', size: 7 }] as const,
    ),
    ...(['month', 'months', 'mon', 'mons'] as const).map(
      (unit) => [unit, { field: 'months', size: 1 }] as const,
    ),
    ...(['year', 'years', 'yr', 'yrs'] as const).map(
      (unit) => [unit, { field: 'months', size: 12 }] as const,
    ),
  ]);

  static resolve(value: unknown, now: Date): Date {
    const normalized = StartAfter.#normalize(value);
    if (normalized === undefined) {
      return now;
    }
    // Errors name the caller's own value, not its normalized form.
    const original = typeof value === 'string' ? value : normalized;
    // plans.js:2228-2230: a string ending in Z or starting with a date is a
    // timestamp, anything else an interval.
    if (normalized.endsWith('Z') || StartAfter.#isoDate.test(normalized)) {
      return StartAfter.#timestamp(normalized, original);
    }
    return StartAfter.#add(now, StartAfter.#interval(normalized, original));
  }

  // attorney.js:140-146
  static #normalize(value: unknown): string | undefined {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Number(value) > 0) {
      return String(value);
    }
    if (typeof value === 'string') {
      // attorney.js:115-117, pinZonelessDateTime.
      return StartAfter.#isoDate.test(value) &&
        StartAfter.#zonelessTime.test(value.slice(10))
        ? `${value}Z`
        : value;
    }
    return undefined;
  }

  static #timestamp(value: string, original: string): Date {
    const match = StartAfter.#dateTime.exec(value);
    if (!match) {
      throw new UnsupportedStartAfterError(original);
    }
    const [, date, hour = '00', minute = '00', second = '00', fraction, zone] =
      match;
    const offset =
      zone === undefined || zone === 'Z'
        ? 'Z'
        : `${zone.slice(0, 3)}:${zone.slice(3).replace(':', '') || '00'}`;
    const milliseconds = fraction === undefined ? '' : `.${fraction}`;
    return new Date(
      `${date}T${hour}:${minute}:${second}${milliseconds}${offset}`,
    );
  }

  static #interval(value: string, original: string): Interval {
    const trimmed = value.trim();
    if (StartAfter.#seconds.test(trimmed)) {
      return { months: 0, days: 0, milliseconds: Number(trimmed) * 1000 };
    }
    const duration = StartAfter.#isoDuration.exec(trimmed);
    if (duration && trimmed !== 'P' && !trimmed.endsWith('T')) {
      const [, years, months, weeks, days, hours, minutes, seconds] = duration;
      return {
        months: Number(years ?? 0) * 12 + Number(months ?? 0),
        days: Number(weeks ?? 0) * 7 + Number(days ?? 0),
        milliseconds:
          Number(hours ?? 0) * 3_600_000 +
          Number(minutes ?? 0) * 60_000 +
          Number(seconds ?? 0) * 1000,
      };
    }
    return StartAfter.#units(trimmed, original);
  }

  static #units(trimmed: string, original: string): Interval {
    if (!StartAfter.#unitsShape.test(trimmed)) {
      throw new UnsupportedStartAfterError(original);
    }
    const interval: Interval = { months: 0, days: 0, milliseconds: 0 };
    for (const [, amount, unit] of trimmed.matchAll(StartAfter.#unitPairs)) {
      const scale = StartAfter.#unitScales.get(String(unit).toLowerCase());
      if (scale === undefined) {
        throw new UnsupportedStartAfterError(original);
      }
      interval[scale.field] += Number(amount) * scale.size;
    }
    return interval;
  }

  // Postgres adds an interval's months (clamped to the target month's last
  // day), then its days, then its time part.
  static #add(now: Date, interval: Interval): Date {
    const result = new Date(now.getTime());
    if (interval.months !== 0) {
      const day = result.getUTCDate();
      result.setUTCDate(1);
      result.setUTCMonth(result.getUTCMonth() + interval.months);
      const lastDay = new Date(
        Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
      ).getUTCDate();
      result.setUTCDate(Math.min(day, lastDay));
    }
    result.setUTCDate(result.getUTCDate() + interval.days);
    return new Date(result.getTime() + interval.milliseconds);
  }
}
