// pg-boss stores a throttle slot as `timestamp` without a time zone
// (node_modules/pg-boss/dist/plans.js:2279), and Postgres drivers read such a
// value as local wall-clock time: node-postgres builds it with
// `new Date(year, month, day, ...)` (node_modules/postgres-date/index.js:50),
// and PGlite does the same, so `singletonOn` lands shifted by the process's
// UTC offset. This stores the slot's UTC wall clock with no zone and reads it
// back the same way.
export class NaiveTimestamp {
  static readonly #shape =
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;

  static fromUtc(instant: Date): string {
    return instant.toISOString().replace('T', ' ').replace('Z', '');
  }

  static toLocal(stored: string): Date {
    const parts = NaiveTimestamp.#shape.exec(stored);
    if (!parts) {
      throw new Error(`Unreadable stored timestamp: ${stored}`);
    }
    return new Date(
      Number(parts[1]),
      Number(parts[2]) - 1,
      Number(parts[3]),
      Number(parts[4]),
      Number(parts[5]),
      Number(parts[6]),
      Number(parts[7]),
    );
  }
}
