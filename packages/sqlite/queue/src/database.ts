// Extended result codes (https://www.sqlite.org/rescode.html#constraint_unique,
// #constraint_foreignkey); Postgres's are SQLSTATE 23505 and 23503.
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;
const SQLITE_CONSTRAINT_NOTNULL = 1299;

export class Database {
  // node:sqlite carries SQLite's extended result code as `errcode`.
  static isUniqueViolation(error: unknown): boolean {
    return Database.#hasErrcode(error, SQLITE_CONSTRAINT_UNIQUE);
  }

  // SQLite names no constraint, so callers name pg-boss's.
  static isForeignKeyViolation(error: unknown): boolean {
    return Database.#hasErrcode(error, SQLITE_CONSTRAINT_FOREIGNKEY);
  }

  // The column a NOT NULL violation names (`NOT NULL constraint failed:
  // table.column`), or undefined for any other error.
  static notNullColumn(error: unknown): string | undefined {
    if (
      !(error instanceof Error) ||
      !Database.#hasErrcode(error, SQLITE_CONSTRAINT_NOTNULL)
    ) {
      return undefined;
    }
    return error.message.slice(error.message.lastIndexOf('.') + 1);
  }

  static #hasErrcode(error: unknown, errcode: number): boolean {
    return (
      error instanceof Error && 'errcode' in error && error.errcode === errcode
    );
  }
}
