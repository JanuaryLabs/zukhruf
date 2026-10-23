export class SqlValues {
  static asIso(value: Date): string {
    return value.toISOString();
  }

  static parseNullableDate(value: string | null | undefined): Date | null {
    return value ? new Date(value) : null;
  }

  static addSeconds(date: Date, seconds: number): Date {
    return new Date(date.getTime() + seconds * 1000);
  }

  // A timestamp column plus a seconds column, in asIso's format, so it
  // compares with an asIso value as text; SQLite keeps whole milliseconds.
  static plusSecondsSql(timestamp: string, seconds: string): string {
    return `strftime('%Y-%m-%dT%H:%M:%fZ', ${timestamp}, '+' || ${seconds} || ' seconds')`;
  }

  // A text parameter as the oracle's driver binds it: a non-string as its
  // String() (probed on PGlite: 0 as '0', false as 'false'), where node:sqlite
  // would bind a number as REAL ('0.0').
  static text(value: unknown): string | null {
    return value === null || value === undefined ? null : String(value);
  }

  static toSqlBool(value: boolean | undefined): number | undefined {
    return value === undefined ? undefined : value ? 1 : 0;
  }
}
