/**
 * The port through which the SQL Server retrievers send their SQL: the host
 * writes it over its own driver, as for the SQL Server store of
 * `@zukhruf/embedding-cache`. The parameters are named, `@p0` for the key
 * `p0`, and the promise gives the rows of the result. It rejects with the
 * error of the driver as it is. The retrievers and the store pass the
 * `signal` of their call: when it aborts, the session cancels the query,
 * with mssql's `request.cancel()`, and rejects with the signal's reason (ADR
 * 0017).
 */
export type SqlServerSession = {
  query(
    sql: string,
    parameters: Readonly<Record<string, unknown>>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly Record<string, unknown>[]>;
};
