import { Gauge } from '@zukhruf/async';

import { FollowedDatabase } from './followed-database.ts';
import { StampedDatabase } from './stamped-database.ts';

// What tells one moment of the database from the next.
type ObservedDatabase = Disposable & { observe(): string };

// The owner commits through a WAL it keeps open, and file-change events
// report a write only when the file closes. SQLite's data_version changes on
// every commit by another connection, so polling current sees each one.
// The owner can also replace the file at the path. A new connection's
// data_version starts again and can equal an old value, so current is a
// count of the changes seen, not the data_version itself.
// It exists to tell a change, so it is a gauge: a change watcher reads current.
export class DataVersion extends Gauge<number> implements Disposable {
  readonly #database: ObservedDatabase;
  #seen: string;
  #current = 0;

  constructor(
    path: string,
    database: ObservedDatabase = new FollowedDatabase(path),
  ) {
    super();
    this.#database = database;
    this.#seen = this.#database.observe();
  }

  // The version of a database whose owner holds SQLite's exclusive locking
  // mode, as Chromium holds its History: the owner lets no reader read
  // data_version, so the file stamp of the database file tells its commits
  // apart.
  static ofExclusiveOwner(path: string): DataVersion {
    return new DataVersion(path, new StampedDatabase(path));
  }

  get current(): number {
    const observed = this.#database.observe();
    if (observed !== this.#seen) {
      this.#seen = observed;
      this.#current += 1;
    }
    return this.#current;
  }

  protected async read(): Promise<number> {
    return this.current;
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}
