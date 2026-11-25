/**
 * The port through which the Postgres retrievers send their SQL: the host
 * writes it over its own driver. The parameters are positional, `$1` for the
 * first, and the promise gives the rows of the result. The retrievers and
 * the store pass the `signal` of their call: when it aborts, the session
 * cancels the query, with `pg_cancel_backend` since node-postgres takes no
 * signal, and rejects with the signal's reason (ADR 0017).
 */
export type PostgresSession = {
  query(
    sql: string,
    parameters: readonly unknown[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly Record<string, unknown>[]>;
};
