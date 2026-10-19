import { DatabaseSync } from 'node:sqlite';

// How a database stores the objects of a declaration: none of them, each one
// as declared, or anything else.
export type Drift = 'missing' | 'stale' | 'fits';

type SchemaObject = {
  readonly type: string;
  readonly name: string;
  readonly sql: string;
};

// The tables, indexes, views and triggers a caller owns in a SQLite database,
// by the CREATE statements that make them. SQLite keeps the text of each
// CREATE in sqlite_schema. A declaration makes its objects once in an empty
// database in memory, so the declared text and the stored text both come from
// SQLite, and they compare as they are.
export class Declaration {
  readonly #objects: readonly SchemaObject[];

  constructor(statements: readonly string[]) {
    using blank = new DatabaseSync(':memory:');
    for (const statement of statements) blank.exec(statement);
    this.#objects = blank
      .prepare(
        'SELECT "type", "name", "sql" FROM sqlite_schema WHERE "sql" IS NOT NULL ORDER BY rowid',
      )
      .all()
      .map(({ type, name, sql }) => ({
        type: String(type),
        name: String(name),
        sql: String(sql),
      }));
  }

  drift(database: DatabaseSync): Drift {
    const pairs = this.#objects.map((object) => ({
      object,
      found: stored(database, object.name),
    }));
    if (pairs.every(({ found }) => found === undefined)) return 'missing';
    return pairs.every(({ object, found }) => found?.sql === object.sql)
      ? 'fits'
      : 'stale';
  }

  // Creates the objects the database does not store. When any stored object
  // differs from its declaration, replaces every object of the declaration,
  // with its rows: a table can refer to another, and SQLite drops a table only
  // after nothing refers to its rows. Works inside the caller's transaction,
  // or in a write of its own. Objects the declaration does not name stay.
  apply(database: DatabaseSync): void {
    if (this.drift(database) === 'fits') return;
    const ownsTransaction = !database.isTransaction;
    database.exec(
      ownsTransaction ? 'BEGIN IMMEDIATE' : 'SAVEPOINT sqlite_drift',
    );
    try {
      const stale = this.#objects.some((object) => {
        const found = stored(database, object.name);
        return found !== undefined && found.sql !== object.sql;
      });
      if (stale)
        for (const object of this.#objects.toReversed()) {
          const found = stored(database, object.name);
          if (found !== undefined)
            database.exec(
              `DROP ${found.type.toUpperCase()} ${quote(found.name)}`,
            );
        }
      for (const object of this.#objects)
        if (stored(database, object.name) === undefined)
          database.exec(object.sql);
      database.exec(ownsTransaction ? 'COMMIT' : 'RELEASE sqlite_drift');
    } catch (error) {
      if (!ownsTransaction) {
        database.exec('ROLLBACK TO sqlite_drift');
        database.exec('RELEASE sqlite_drift');
      } else if (database.isTransaction) {
        database.exec('ROLLBACK');
      }
      throw error;
    }
  }
}

// SQLite takes names that differ only in ASCII case for one object.
function stored(
  database: DatabaseSync,
  name: string,
): SchemaObject | undefined {
  const row = database
    .prepare(
      'SELECT "type", "name", "sql" FROM sqlite_schema WHERE lower("name") = lower(?)',
    )
    .get(name);
  return row === undefined
    ? undefined
    : { type: String(row.type), name: String(row.name), sql: String(row.sql) };
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
