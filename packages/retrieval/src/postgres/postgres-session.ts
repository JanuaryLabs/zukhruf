/**
 * The port through which the Postgres retrievers send their SQL: the host
 * writes it over its own driver. The parameters are positional, `$1` for the
 * first, and the promise gives the rows of the result.
 */
export type PostgresSession = {
  query(
    sql: string,
    parameters: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
};
