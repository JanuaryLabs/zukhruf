import { identifier } from '../sql/identifier.ts';
import { type SqlDialect, scalar } from '../sql/where.ts';
import { bind } from './bind.ts';

/** The filter SQL of Postgres: `$1` placeholders, and a boolean binds as a boolean. */
export const dialect: SqlDialect<unknown[], unknown> = {
  identifier,
  bind,
  value: scalar,
};
