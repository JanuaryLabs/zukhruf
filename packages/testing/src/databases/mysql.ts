import type { DatabaseOptions } from './database.ts';
import { mysql } from './mysql-family-collector.ts';
import {
  type MysqlFamilyDatabase,
  MysqlFamilyServer,
} from './mysql-family-server.ts';

export type { Database, DatabaseOptions } from './database.ts';

export type MysqlOptions = DatabaseOptions;

export type MysqlDatabase = MysqlFamilyDatabase;

export class Mysql extends MysqlFamilyServer {
  protected override readonly collector = mysql;
  protected override readonly scheme = 'mysql';

  constructor({ image = 'mysql:lts', ...options }: MysqlOptions) {
    super({ ...options, image });
  }

  protected override environment(password: string, database: string) {
    return { MYSQL_ROOT_PASSWORD: password, MYSQL_DATABASE: database };
  }
}
