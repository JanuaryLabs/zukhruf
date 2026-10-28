import { FollowedDatabase } from './followed-database.ts';

// The owner commits through a WAL it keeps open, and file-change events
// report a write only when the file closes. SQLite's data_version changes on
// every commit by another connection, so polling current sees each one.
// The owner can also replace the file at the path. A new connection's
// data_version starts again and can equal an old value, so current is a
// count of the changes seen, not the data_version itself.
export class DataVersion implements Disposable {
  readonly #database: FollowedDatabase;
  #seen: string;
  #current = 0;

  constructor(path: string) {
    this.#database = new FollowedDatabase(path);
    this.#seen = this.#database.observe();
  }

  get current(): number {
    const observed = this.#database.observe();
    if (observed !== this.#seen) {
      this.#seen = observed;
      this.#current += 1;
    }
    return this.#current;
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}
