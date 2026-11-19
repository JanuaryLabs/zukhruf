/** A pool and its end, which resolves with the number of its members that were still checked out. */
export interface OwnedPool<Pool> {
  readonly pool: Pool;
  end(): Promise<number>;
}

/** The word of a driver for one connection of its pool: pg says client, mysql2, mariadb and mssql say connection. */
export type PoolMember = 'client' | 'connection';

const leak = (count: number, member: PoolMember, of: string) =>
  new Error(
    `The disposal destroyed ${count} ${member}${count === 1 ? '' : 's'} of ${of} that ${count === 1 ? 'was' : 'were'} still checked out.`,
  );

/**
 * A pool for a test that has no handle. Its disposal ends the pool, and
 * rejects when it destroyed a member that was still checked out.
 */
export function disposablePool<Pool>(
  { pool, end }: OwnedPool<Pool>,
  member: PoolMember,
): AsyncDisposable & { readonly pool: Pool } {
  return {
    pool,
    async [Symbol.asyncDispose]() {
      const leaked = await end();
      if (leaked > 0) throw leak(leaked, member, 'a pool');
    },
  };
}

/**
 * The pools of one database handle (ADR 0026). `add` keeps each pool it
 * builds, and throws once the disposal started; `dispose` ends every pool at
 * the same time, then releases the database, then throws the count of the
 * members that were still checked out.
 */
export class OwnedPools<Pool> {
  readonly #member: PoolMember;
  readonly #pools: OwnedPool<Pool>[] = [];
  readonly #disposal = new AbortController();

  constructor(member: PoolMember) {
    this.#member = member;
  }

  add(build: () => OwnedPool<Pool>): Pool {
    if (this.#disposal.signal.aborted)
      throw new Error('The disposal of this database has started.');
    const pool = build();
    this.#pools.push(pool);
    return pool.pool;
  }

  async dispose(release: () => Promise<void>): Promise<void> {
    this.#disposal.abort();
    const ending = this.#pools.splice(0);
    const leaked = await Promise.all(ending.map((pool) => pool.end()));
    await release();
    const count = leaked.reduce((sum, n) => sum + n, 0);
    if (count > 0) throw leak(count, this.#member, 'a pool of this database');
  }
}
