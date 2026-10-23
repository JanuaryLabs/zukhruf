import assert from 'node:assert/strict';

import {
  type ParityRun,
  PgBossBackend,
  type RunOptions,
  SqliteBackend,
} from './backends.ts';

// Runs one scenario on each backend, pg-boss first, each on a fresh queue torn
// down before the next opens with the same supervisor options, and requires
// SQLite to observe exactly what pg-boss observed.
export class Parity {
  static readonly backends = [
    new PgBossBackend(),
    new SqliteBackend(),
  ] as const;

  static async assertSame<T>(
    scenario: (run: ParityRun) => Promise<T>,
    options: RunOptions = {},
  ): Promise<T> {
    const [pgBossBackend, sqliteBackend] = Parity.backends;
    const pgBoss = await Parity.#observe(pgBossBackend, scenario, options);
    const sqlite = await Parity.#observe(sqliteBackend, scenario, options);
    assert.notEqual(pgBoss, undefined, 'pg-boss observed nothing');
    assert.deepStrictEqual(sqlite, pgBoss);
    return pgBoss;
  }

  static async #observe<T>(
    backend: PgBossBackend | SqliteBackend,
    scenario: (run: ParityRun) => Promise<T>,
    options: RunOptions,
  ): Promise<T> {
    const run = await backend.open(options);
    try {
      return await scenario(run);
    } finally {
      await run.close();
    }
  }
}
