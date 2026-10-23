import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { transaction } from '@zukhruf/sqlite-transaction';

// How a database stores the objects of a declaration: none of them, each one
// as declared, or anything else.
export type Drift = 'missing' | 'stale' | 'fits';

// What apply does with the rows of a stale table: drop them with the whole
// declaration, or keep them in a table made again from its declaration.
export type Rows = 'replace' | 'keep';

type SchemaObject = {
  readonly type: string;
  readonly name: string;
  readonly sql: string;
};

// A declared object and the stored object of the same name, whose text differs.
type Stale = { readonly object: SchemaObject; readonly found: SchemaObject };

// The tables, indexes, views and triggers a caller owns in a SQLite database,
// by the CREATE statements that make them, one statement for each object.
// SQLite keeps the text of each CREATE in sqlite_schema. A declaration makes
// its objects once in an empty database in memory, so the declared text and
// the stored text both come from SQLite, and they compare as they are. The
// other rows that a statement adds to sqlite_schema (shadow tables,
// sqlite_sequence) are owned objects: SQLite makes and drops them with the
// declared object (ADR 0004).
export class Declaration {
  readonly #objects: readonly SchemaObject[];
  readonly #rows: Rows;

  constructor(statements: readonly string[], options: { readonly rows: Rows }) {
    using blank = new DatabaseSync(':memory:');
    this.#objects = statements.map((statement) => declare(blank, statement));
    this.#rows = options.rows;
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
  // differs from its declaration, rows 'replace' replaces every object of the
  // declaration, with its rows: a table can refer to another, and SQLite drops
  // a table only after nothing refers to its rows. Rows 'keep' makes each stale
  // object again, and moves the rows of a stale table into the new one (ADR
  // 0003). Works inside the caller's transaction, or in a write of its own.
  // Objects the declaration does not name stay.
  apply(database: DatabaseSync): void {
    if (this.drift(database) === 'fits') return;
    if (this.#rows === 'keep')
      for (const { object, found } of this.#stale(database))
        if (virtual(object) || virtual(found))
          throw new Error(
            `The virtual table ${object.name} cannot keep its rows: declare it in its own declaration with rows: 'replace'.`,
          );
    // SQLite ignores PRAGMA foreign_keys in a transaction. With foreign keys
    // on, the rename of a referenced table changes the references to the old
    // table, and its drop then deletes the rows that refer to it.
    const unchecked =
      this.#rows === 'keep' &&
      Number(database.prepare('PRAGMA foreign_keys').get()?.foreign_keys) ===
        1 &&
      this.#stale(database).some(
        ({ object, found }) =>
          object.type === 'table' &&
          found.type === 'table' &&
          referenced(database, found.name),
      );
    if (unchecked) {
      if (database.isTransaction)
        throw new Error(
          'Keeping the rows of a table that other tables reference needs foreign keys off, which SQLite cannot change inside a transaction. Call apply outside a transaction, or turn foreign keys off before it.',
        );
      database.exec('PRAGMA foreign_keys = OFF');
    }
    try {
      transaction(
        database,
        () => {
          const stale = this.#stale(database);
          if (this.#rows === 'keep') {
            const views = compiled(database);
            const rebuilt = this.#keep(database, stale);
            this.#create(database);
            verify(database, rebuilt, views);
          } else {
            if (stale.length > 0)
              for (const object of this.#objects.toReversed()) {
                const found = stored(database, object.name);
                if (found !== undefined) drop(database, found);
              }
            this.#create(database);
          }
        },
        { mode: 'immediate' },
      );
    } finally {
      if (unchecked) database.exec('PRAGMA foreign_keys = ON');
    }
  }

  #create(database: DatabaseSync): void {
    for (const object of this.#objects)
      if (stored(database, object.name) === undefined)
        database.exec(object.sql);
  }

  #stale(database: DatabaseSync): Stale[] {
    return this.#objects.flatMap((object) => {
      const found = stored(database, object.name);
      return found !== undefined && found.sql !== object.sql
        ? [{ object, found }]
        : [];
    });
  }

  // Drops each stale index, trigger and view, rebuilds each stale table, and
  // gives the names of the rebuilt tables. SQLite keeps PRAGMA
  // legacy_alter_table after a rollback, so the old value comes back in any
  // case.
  #keep(database: DatabaseSync, stale: readonly Stale[]): string[] {
    const tables = stale.filter(
      ({ object, found }) => object.type === 'table' && found.type === 'table',
    );
    for (const entry of stale)
      if (!tables.includes(entry)) drop(database, entry.found);
    if (tables.length === 0) return [];
    const legacy = Number(
      database.prepare('PRAGMA legacy_alter_table').get()?.legacy_alter_table,
    );
    database.exec('PRAGMA legacy_alter_table = ON');
    try {
      for (const { object, found } of tables)
        this.#rebuild(database, object, found);
    } finally {
      database.exec(`PRAGMA legacy_alter_table = ${legacy}`);
    }
    const broken = database.prepare('PRAGMA foreign_key_check').get();
    if (broken !== undefined)
      throw new Error(
        `The kept rows break a foreign key: row ${String(broken.rowid)} of ${String(broken.table)} refers to a row of ${String(broken.parent)} that does not exist.`,
      );
    return tables.map(({ object }) => object.name);
  }

  // Renames the stored table away, makes it from its declared text, and copies
  // the columns that both have, by name. With legacy_alter_table on, the
  // rename leaves the references of other tables, views and triggers to the
  // name. A column only the declaration has gets its default, and a column
  // only the stored table has is discarded. The indexes and triggers on the
  // table go with the old table, so those the declaration does not name are
  // made again here, and the others when apply makes the missing objects.
  #rebuild(
    database: DatabaseSync,
    object: SchemaObject,
    found: SchemaObject,
  ): void {
    const declared = new Set(
      this.#objects.map(({ name }) => name.toLowerCase()),
    );
    const undeclared = database
      .prepare(
        `SELECT "name", "sql" FROM sqlite_schema WHERE lower("tbl_name") = lower(?) AND "type" IN ('index', 'trigger') AND "sql" IS NOT NULL`,
      )
      .all(found.name)
      .filter(({ name }) => !declared.has(String(name).toLowerCase()))
      .map(({ sql }) => String(sql));
    const old = `${found.name}_${randomUUID().replaceAll('-', '')}`;
    database.exec(`ALTER TABLE ${quote(found.name)} RENAME TO ${quote(old)}`);
    // The sqlite_sequence row of the table follows the rename.
    const counter = sequence(database, old);
    database.exec(object.sql);
    const columns = new Set(
      names(database, object.name).map((name) => name.toLowerCase()),
    );
    const shared = names(database, old)
      .filter((name) => columns.has(name.toLowerCase()))
      .map(quote);
    const into = [...shared];
    const from = [...shared];
    // pragma_table_info does not list the rowid, so a copy of the columns
    // gives new rowids. The rowid goes first: when the list also has the
    // INTEGER PRIMARY KEY of the new table, SQLite takes the later value.
    const target = rowid(database, object.name);
    const source = rowid(database, old);
    if (target !== undefined && source !== undefined) {
      into.unshift(target);
      from.unshift(source);
    }
    if (into.length > 0)
      database.exec(
        `INSERT INTO ${quote(object.name)} (${into.join(', ')}) SELECT ${from.join(', ')} FROM ${quote(old)}`,
      );
    // AUTOINCREMENT gives no id that the table gave before, also when its row
    // is gone. sqlite_sequence keeps the largest such id. The copy gives no
    // id larger than the old counter.
    if (counter !== undefined && /\bAUTOINCREMENT\b/i.test(object.sql)) {
      database
        .prepare('DELETE FROM sqlite_sequence WHERE "name" = ?')
        .run(object.name);
      database
        .prepare('INSERT INTO sqlite_sequence ("name", "seq") VALUES (?, ?)')
        .run(object.name, counter);
    }
    database.exec(`DROP TABLE ${quote(old)}`);
    for (const sql of undeclared) database.exec(sql);
  }
}

// Runs one element of a declaration in the blank database, and gives the
// object that the element declares: the first row that it adds to
// sqlite_schema. The other rows that it adds (the shadow tables of a virtual
// table, sqlite_sequence, the index of a UNIQUE column) belong to that object:
// SQLite makes and drops them with it (ADR 0004).
function declare(blank: DatabaseSync, element: string): SchemaObject {
  const last = Number(
    blank
      .prepare('SELECT coalesce(max(rowid), 0) AS "last" FROM sqlite_schema')
      .get()?.last,
  );
  // prepare compiles the first statement of the text and ignores the rest.
  const statement = blank.prepare(element);
  statement.run();
  if (holds(blank, element.slice(statement.sourceSQL.length)))
    throw new Error(
      `An element of a declaration holds one statement. This element holds more: ${element}`,
    );
  const made = blank
    .prepare(
      'SELECT "type", "name", "sql" FROM sqlite_schema WHERE rowid > ? ORDER BY rowid',
    )
    .get(last);
  if (made === undefined)
    throw new Error(
      `An element of a declaration makes one object. This element makes none: ${element}`,
    );
  return {
    type: String(made.type),
    name: String(made.name),
    sql: String(made.sql),
  };
}

// Whether the text holds a statement. SQLite compiles no statement from a
// text of spaces, comments and semicolons, and node:sqlite then throws.
function holds(database: DatabaseSync, text: string): boolean {
  try {
    database.prepare(text);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_INVALID_ARG_VALUE'
    );
  }
}

function virtual(object: SchemaObject): boolean {
  return /^CREATE VIRTUAL TABLE /i.test(object.sql);
}

// The name that reads the rowid of the table: none for a WITHOUT ROWID table,
// and none when columns have each of the three names of the rowid.
function rowid(database: DatabaseSync, table: string): string | undefined {
  const list = database
    .prepare('SELECT "wr" FROM pragma_table_list(?)')
    .get(table);
  if (Number(list?.wr) === 1) return undefined;
  const columns = new Set(
    names(database, table).map((name) => name.toLowerCase()),
  );
  return ['rowid', '_rowid_', 'oid'].find((name) => !columns.has(name));
}

// The largest id that an AUTOINCREMENT table gave, as sqlite_sequence keeps it.
function sequence(database: DatabaseSync, table: string): number | undefined {
  if (stored(database, 'sqlite_sequence') === undefined) return undefined;
  const row = database
    .prepare('SELECT "seq" FROM sqlite_sequence WHERE "name" = ?')
    .get(table);
  return row === undefined ? undefined : Number(row.seq);
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

function drop(database: DatabaseSync, object: SchemaObject): void {
  database.exec(`DROP ${object.type.toUpperCase()} ${quote(object.name)}`);
}

function names(database: DatabaseSync, table: string): string[] {
  return database
    .prepare('SELECT "name" FROM pragma_table_info(?)')
    .all(table)
    .map(({ name }) => String(name));
}

// The names of the views that SQLite can compile now.
function compiled(database: DatabaseSync): Set<string> {
  return new Set(
    database
      .prepare(`SELECT "name" FROM sqlite_schema WHERE "type" = 'view'`)
      .all()
      .map(({ name }) => String(name))
      .filter((name) => {
        try {
          database.prepare(`SELECT * FROM ${quote(name)} WHERE 0`);
          return true;
        } catch {
          // The view was broken before apply.
          return false;
        }
      }),
  );
}

// SQLite checks the columns of a trigger or a view only when it compiles a
// statement that uses it, not at CREATE. Each statement here compiles every
// trigger on a rebuilt table for its event, and runs no row: an UPDATE trigger
// OF a column compiles only when SET names that column. A view that compiled
// before the rebuilds and does not compile now fails apply; a view that was
// already broken does not.
function verify(
  database: DatabaseSync,
  tables: readonly string[],
  views: ReadonlySet<string>,
): void {
  for (const table of tables) {
    const columns = names(database, table).map(quote);
    const name = quote(table);
    database.prepare(`DELETE FROM ${name} WHERE 0`);
    database.prepare(
      `INSERT INTO ${name} (${columns.join(', ')}) SELECT ${columns.join(', ')} FROM ${name} WHERE 0`,
    );
    database.prepare(
      `UPDATE ${name} SET ${columns.map((column) => `${column} = ${column}`).join(', ')} WHERE 0`,
    );
  }
  for (const view of views)
    try {
      database.prepare(`SELECT * FROM ${quote(view)} WHERE 0`);
    } catch (error) {
      throw new Error(`The rebuild breaks the view ${view}.`, {
        cause: error,
      });
    }
}

// Whether a table, the same one too, has a foreign key to the table.
function referenced(database: DatabaseSync, table: string): boolean {
  return (
    database
      .prepare(
        `SELECT 1 FROM sqlite_schema AS "s", pragma_foreign_key_list("s"."name") AS "f" WHERE "s"."type" = 'table' AND lower("f"."table") = lower(?)`,
      )
      .get(table) !== undefined
  );
}
