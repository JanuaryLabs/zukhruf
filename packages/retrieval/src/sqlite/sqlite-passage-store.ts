import type { DatabaseSync } from 'node:sqlite';

import type { PassageStore } from '../passage-store.ts';
import type { Passage } from '../passage.ts';
import { identifier } from './identifier.ts';
import { passageRows } from './passage-rows.ts';

/** Reads the passages of the passage contract in SQLite by id, and the neighbours of a passage in its source. */
export class SqlitePassageStore implements PassageStore {
  readonly #database: DatabaseSync;
  readonly #passages: string;

  constructor(options: {
    readonly database: DatabaseSync;
    readonly passages: string;
  }) {
    this.#database = options.database;
    this.#passages = identifier(options.passages);
  }

  async get(ids: readonly string[]): Promise<ReadonlyMap<string, Passage>> {
    const statement = this.#database.prepare(
      `SELECT p.* FROM ${this.#passages} p WHERE p."id" IN (SELECT "value" FROM json_each(?))`,
    );
    return new Map(
      passageRows(statement, 0, [JSON.stringify(ids)]).map(({ passage }) => [
        passage.id,
        passage,
      ]),
    );
  }

  /**
   * The passages of the source from `seq - windowSize` to `seq + windowSize`,
   * the passage itself among them, in the order of `seq`, as Haystack's
   * `SentenceWindowRetriever` reads its window.
   */
  async neighbours(options: {
    readonly source: string;
    readonly seq: number;
    readonly windowSize: number;
  }): Promise<Passage[]> {
    const statement = this.#database.prepare(
      `SELECT p.* FROM ${this.#passages} p WHERE p."source" = ? AND p."seq" BETWEEN ? AND ? ORDER BY p."seq", p."id"`,
    );
    return passageRows(statement, 0, [
      options.source,
      options.seq - options.windowSize,
      options.seq + options.windowSize,
    ]).map(({ passage }) => passage);
  }
}
