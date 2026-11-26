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

/** Runs `sqlcmd` of the `mssql/server` image in the server's container (ADR 0020, item 8). */
export const sqlserver: Collector = {
  kind: 'sqlserver',
  credential: { variable: 'MSSQL_SA_PASSWORD' },
  command: (password, sql) => [
    '/opt/mssql-tools18/bin/sqlcmd',
    '-C',
    '-S',
    'localhost',
    '-U',
    'sa',
    '-P',
    password,
    '-b',
    '-h',
    '-1',
    '-W',
    '-Q',
    `SET NOCOUNT ON; ${sql}`,
  ],
  drop: (name) =>
    `IF DB_ID('${name}') IS NOT NULL BEGIN ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}]; END`,
};
