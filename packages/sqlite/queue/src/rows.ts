export type SqliteRow = Record<string, unknown>;

export class Row {
  static #isSqliteRow(value: unknown): value is SqliteRow {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  static parse(value: unknown, label: string): SqliteRow {
    if (!Row.#isSqliteRow(value)) {
      throw new Error(`Expected SQLite row for ${label}`);
    }

    return value;
  }

  static readString(row: SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value !== 'string') {
      throw new Error(`Expected string SQLite column: ${column}`);
    }

    return value;
  }

  static readNullableString(row: SqliteRow, column: string): string | null {
    const value = row[column];
    if (value === null) {
      return null;
    }
    if (typeof value !== 'string') {
      throw new Error(`Expected nullable string SQLite column: ${column}`);
    }

    return value;
  }

  static readNumber(row: SqliteRow, column: string): number {
    const value = row[column];
    if (typeof value !== 'number') {
      throw new Error(`Expected number SQLite column: ${column}`);
    }

    return value;
  }

  static readNullableNumber(row: SqliteRow, column: string): number | null {
    const value = row[column];
    if (value === null) {
      return null;
    }
    if (typeof value !== 'number') {
      throw new Error(`Expected nullable number SQLite column: ${column}`);
    }

    return value;
  }
}
