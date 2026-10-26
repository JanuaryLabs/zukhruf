import type { Container } from '@zukhruf/docker';

import type { Collector, Kind } from './collector.ts';
import { succeeded } from './succeeded.ts';

export interface MysqlFamilyServer {
  container: Container;
  password: string;
}

/** The image creates only root, from the root password in its environment. */
export const user = 'root';

export interface MysqlFamilyCollector extends Collector<MysqlFamilyServer> {
  /** The client in the image. */
  readonly client: string;
}

/** Runs the image's client in the server's container. */
function mysqlFamily(
  kind: Kind,
  client: string,
  passwordVariable: string,
): MysqlFamilyCollector {
  const execute = (
    { container, password }: MysqlFamilyServer,
    args: string[],
  ) => succeeded(container, [client, `-u${user}`, `-p${password}`, ...args]);
  return {
    kind,
    client,
    async open(container, environment) {
      const password = environment[passwordVariable];
      if (password === undefined)
        throw new Error(
          `The ${kind} server ${container.id} has no ${passwordVariable}`,
        );
      return { container, password, [Symbol.asyncDispose]: async () => {} };
    },
    async list(server) {
      const stdout = await execute(server, [
        '--batch',
        '--skip-column-names',
        '--execute',
        "SHOW DATABASES LIKE 'test%'",
      ]);
      return stdout.split('\n').filter(Boolean);
    },
    async drop(server, name) {
      await execute(server, [
        '--execute',
        `DROP DATABASE IF EXISTS \`${name}\``,
      ]);
    },
  };
}

export const mysql = mysqlFamily('mysql', 'mysql', 'MYSQL_ROOT_PASSWORD');
/** MariaDB 11 and later ship only the mariadb client, not mysql. */
export const mariadb = mysqlFamily(
  'mariadb',
  'mariadb',
  'MARIADB_ROOT_PASSWORD',
);
