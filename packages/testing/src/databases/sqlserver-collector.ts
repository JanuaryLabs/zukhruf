import sql from 'mssql';

import type { Collector } from './collector.ts';

export interface SqlServerServer {
  host: string;
  port: number;
  password: string;
}

export const connectionString = (
  { host, port, password }: SqlServerServer,
  database: string,
): string =>
  `Server=${host},${port};Database=${database};User Id=sa;Password=${password};TrustServerCertificate=true;Encrypt=false;`;

async function query(
  server: SqlServerServer,
  text: string,
): Promise<Record<string, unknown>[]> {
  const pool = new sql.ConnectionPool(connectionString(server, 'master'));
  try {
    await pool.connect();
    return (await pool.request().query(text)).recordset;
  } finally {
    await pool.close().catch(() => {});
  }
}

/**
 * Speaks to the server with the `mssql` driver: the `azure-sql-edge` image
 * has no `sqlcmd` to exec.
 */
export const sqlserver: Collector<SqlServerServer> = {
  kind: 'sqlserver',
  async open(container, environment, host) {
    const password = environment.MSSQL_SA_PASSWORD;
    if (password === undefined)
      throw new Error(
        `The sqlserver server ${container.id} has no MSSQL_SA_PASSWORD`,
      );
    const published = await container.port(1433);
    if (!published)
      throw new Error(`Container ${container.id} publishes no port for 1433`);
    const forward = await host.forward(published.port);
    return {
      host: '127.0.0.1',
      port: forward.port,
      password,
      [Symbol.asyncDispose]: forward.close,
    };
  },
  async list(server) {
    const rows = await query(
      server,
      "SELECT name FROM sys.databases WHERE name LIKE 'test%'",
    );
    return rows.map(({ name }) => String(name));
  },
  async drop(server, name) {
    await query(
      server,
      `IF DB_ID('${name}') IS NOT NULL BEGIN ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}]; END`,
    );
  },
};
