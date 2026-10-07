import type { DatabaseOptions } from './database.ts';
import {
  type MysqlFamilyDatabase,
  MysqlFamilyServer,
} from './mysql-family-server.ts';

export type { Database, DatabaseOptions } from './database.ts';

export type MariadbOptions = DatabaseOptions;

export type MariadbDatabase = MysqlFamilyDatabase;

export class Mariadb extends MysqlFamilyServer {
  /** MariaDB 11 and later ship only the mariadb client, not mysql. */
  protected override readonly client = 'mariadb';
  protected override readonly scheme = 'mariadb';

  constructor({ image = 'mariadb:lts', ...options }: MariadbOptions) {
    super({ ...options, image });
  }

  protected override environment(password: string, database: string) {
    return { MARIADB_ROOT_PASSWORD: password, MARIADB_DATABASE: database };
  }
}
