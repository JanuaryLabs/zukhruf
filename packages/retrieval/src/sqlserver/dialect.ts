import { type SqlDialect, scalar } from '../sql/where.ts';
import { bind } from './bind.ts';
import { identifier } from './identifier.ts';

/**
 * The filter SQL of SQL Server: `@p0` placeholders, and a boolean binds as a
 * BIT, which compares with a BIT column. A string compares in the collation
 * of its column.
 */
export const dialect: SqlDialect<Record<string, unknown>, unknown> = {
  identifier,
  bind,
  value: scalar,
};
