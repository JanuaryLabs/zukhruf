import type { Collector, Kind } from './collector.ts';

/** The image creates only root, from the root password in its environment. */
export const user = 'root';

export interface MysqlFamilyCollector extends Collector {
  /** The client in the image. */
  readonly client: string;
}

/** Runs the image's client in the server's container. */
function mysqlFamily(
  kind: Kind,
  client: string,
  passwordVariable: string,
): MysqlFamilyCollector {
  return {
    kind,
    client,
    credential: { variable: passwordVariable },
    command: (password, sql) => [
      client,
      `-u${user}`,
      `-p${password}`,
      '--batch',
      '--skip-column-names',
      '--execute',
      sql,
    ],
    drop: (name) => `DROP DATABASE IF EXISTS \`${name}\``,
  };
}

export const mysql = mysqlFamily('mysql', 'mysql', 'MYSQL_ROOT_PASSWORD');
/** MariaDB 11 and later ship only the mariadb client, not mysql. */
export const mariadb = mysqlFamily(
  'mariadb',
  'mariadb',
  'MARIADB_ROOT_PASSWORD',
);
