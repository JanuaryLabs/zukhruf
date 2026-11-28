import assert from 'node:assert/strict';

import {
  type ParityRun,
  PgBossBackend,
  type RunOptions,
  SqliteBackend,
  SqliteThreadBackend,
} from './backends.ts';

// Runs one scenario on each backend, pg-boss first, each on a fresh queue torn
// down before the next opens with the same supervisor options, and requires
// SQLite, on the main thread and in its own thread, to observe exactly what
// pg-boss observed.
export class Parity {
  static readonly backends = [
    new PgBossBackend(),
    new SqliteBackend(),
    new SqliteThreadBackend(),
  ] as const;

  static async assertSame<T>(
    scenario: (run: ParityRun) => Promise<T>,
    options: RunOptions = {},
  ): Promise<T> {
    const [pgBossBackend, sqliteBackend, threadBackend] = Parity.backends;
    const pgBoss = await Parity.#observe(pgBossBackend, scenario, options);
    const sqlite = await Parity.#observe(sqliteBackend, scenario, options);
    assert.notEqual(pgBoss, undefined, 'pg-boss observed nothing');
    assert.deepStrictEqual(sqlite, pgBoss);
    const thread = await Parity.#observe(threadBackend, scenario, options);
    assert.deepStrictEqual(
      thread,
      pgBoss,
      'The thread form observed otherwise',
    );
    return pgBoss;
  }

  /**
   * `assertSame` without the thread form, for a scenario whose observation
   * depends on how a call interleaves with the engine's I/O within one event
   * loop, which a call that crosses to the thread cannot keep. `divergence`
   * names it in ADR 0008.
   */
  static async assertSameOnTheMainThread<T>(
    divergence: string,
    scenario: (run: ParityRun) => Promise<T>,
    options: RunOptions = {},
  ): Promise<T> {
    assert.notEqual(divergence, '', 'A divergence names its reason');
    const [pgBossBackend, sqliteBackend] = Parity.backends;
    const pgBoss = await Parity.#observe(pgBossBackend, scenario, options);
    const sqlite = await Parity.#observe(sqliteBackend, scenario, options);
    assert.notEqual(pgBoss, undefined, 'pg-boss observed nothing');
    assert.deepStrictEqual(sqlite, pgBoss);
    return pgBoss;
  }

  static async #observe<T>(
    backend: PgBossBackend | SqliteBackend | SqliteThreadBackend,
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
