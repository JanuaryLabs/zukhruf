import {
  SQLITE_CONSTRAINT_FOREIGNKEY,
  SQLITE_CONSTRAINT_NOTNULL,
  SQLITE_CONSTRAINT_UNIQUE,
  sqliteResultCode,
} from '@zukhruf/sqlite-open';

// Postgres's codes for the same violations are SQLSTATE 23505 and 23503.
export class Database {
  static isUniqueViolation(error: unknown): boolean {
    return sqliteResultCode(error)?.extendedCode === SQLITE_CONSTRAINT_UNIQUE;
  }

  // SQLite names no constraint, so callers name pg-boss's.
  static isForeignKeyViolation(error: unknown): boolean {
    return (
      sqliteResultCode(error)?.extendedCode === SQLITE_CONSTRAINT_FOREIGNKEY
    );
  }

  // The column a NOT NULL violation names (`NOT NULL constraint failed:
  // table.column`), or undefined for any other error.
  static notNullColumn(error: unknown): string | undefined {
    if (
      !Error.isError(error) ||
      sqliteResultCode(error)?.extendedCode !== SQLITE_CONSTRAINT_NOTNULL
    ) {
      return undefined;
    }
    return error.message.slice(error.message.lastIndexOf('.') + 1);
  }
}
