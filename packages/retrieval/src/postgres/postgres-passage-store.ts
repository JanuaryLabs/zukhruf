import type { PassageStore } from '../passage-store.ts';
import type { Passage } from '../passage.ts';
import { bind } from './bind.ts';
import { identifier } from './identifier.ts';
import { passage, passageJson } from './passage-row.ts';
import type { PostgresSession } from './postgres-session.ts';

/** Reads the passages of the passage contract in Postgres by id, and the neighbours of a passage in its source. */
export class PostgresPassageStore implements PassageStore {
  readonly #session: PostgresSession;
  readonly #passages: string;

  constructor(options: {
    readonly session: PostgresSession;
    readonly passages: string;
  }) {
    this.#session = options.session;
    this.#passages = identifier(options.passages);
  }

  async get(ids: readonly string[]): Promise<ReadonlyMap<string, Passage>> {
    const parameters: unknown[] = [];
    const row = passageJson(parameters, this.#passages);
    const list = bind(parameters, JSON.stringify(ids));
    const rows = await this.#session.query(
      `SELECT ${row} AS "passage" FROM ${this.#passages} p WHERE p."id"::text IN (SELECT jsonb_array_elements_text(${list}::jsonb))`,
      parameters,
    );
    return new Map(
      rows.map((cells) => {
        const found = passage(cells['passage']);
        return [found.id, found];
      }),
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
    const parameters: unknown[] = [];
    const row = passageJson(parameters, this.#passages);
    const source = bind(parameters, options.source);
    const from = bind(parameters, options.seq - options.windowSize);
    const to = bind(parameters, options.seq + options.windowSize);
    const rows = await this.#session.query(
      `SELECT ${row} AS "passage" FROM ${this.#passages} p WHERE p."source" = ${source} AND p."seq" BETWEEN ${from} AND ${to} ORDER BY p."seq", p."id"::text COLLATE "C"`,
      parameters,
    );
    return rows.map((cells) => passage(cells['passage']));
  }
}
