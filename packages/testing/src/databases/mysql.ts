import type { DatabaseOptions } from './database.ts';
import {
  type MysqlCompatibleDatabase,
  MysqlCompatibleServer,
  type MysqlFlavor,
} from './mysql-compatible-server.ts';

export type { Database, DatabaseOptions } from './database.ts';

export type MysqlOptions = DatabaseOptions;

export type MysqlDatabase = MysqlCompatibleDatabase;

const mysql: MysqlFlavor = {
  image: 'mysql:8.4',
  client: 'mysql',
  scheme: 'mysql',
  environment: (password, database) => ({
    MYSQL_ROOT_PASSWORD: password,
    MYSQL_DATABASE: database,
  }),
};

export class Mysql extends MysqlCompatibleServer {
  constructor(options: MysqlOptions) {
    super(mysql, options);
  }
}
