import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  SQLITE_BACKGROUND_QUEUE_TABLES,
  SQLITE_QUEUE_SCHEMA,
} from './schema.ts';

describe('SQLite queue schema', () => {
  it('defines the durable queue, job, and schedule tables', () => {
    assert.deepEqual(SQLITE_BACKGROUND_QUEUE_TABLES, [
      'pgboss_queue',
      'pgboss_job',
      'pgboss_schedule',
    ]);

    const schema = SQLITE_QUEUE_SCHEMA.join('\n');
    assert.match(schema, /CREATE TABLE IF NOT EXISTS pgboss_queue/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS pgboss_job/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS pgboss_schedule/);
  });

  // Every index is `IF NOT EXISTS`, so one that reuses a taken name is skipped
  // without an error: the unique singleton index once never existed this way.
  it('creates every index it declares, unique where declared unique', () => {
    const database = new DatabaseSync(':memory:');
    try {
      for (const statement of SQLITE_QUEUE_SCHEMA) {
        database.exec(statement);
      }
      const declared = SQLITE_QUEUE_SCHEMA.flatMap((statement) => {
        const match =
          /^CREATE (UNIQUE )?INDEX IF NOT EXISTS (\w+)\s+ON (\w+)/.exec(
            statement,
          );
        return match
          ? [{ name: match[2], table: match[3], unique: Boolean(match[1]) }]
          : [];
      });
      const created = declared.map(({ name, table }) => {
        const index = database
          .prepare(`SELECT "unique" FROM pragma_index_list(?) WHERE name = ?`)
          .get(table ?? '', name ?? '');
        return { name, table, unique: index?.unique === 1 };
      });

      assert.ok(declared.length > 0);
      assert.deepEqual(created, declared);
    } finally {
      database.close();
    }
  });

  it('snapshots queue defaults on jobs and preserves exclusive queue semantics', () => {
    const schema = SQLITE_QUEUE_SCHEMA.join('\n');

    assert.match(schema, /retry_limit INTEGER NOT NULL DEFAULT 2/);
    assert.match(schema, /expire_seconds INTEGER NOT NULL DEFAULT 900/);
    assert.match(schema, /heartbeat_seconds INTEGER/);
    assert.match(
      schema,
      /CREATE UNIQUE INDEX IF NOT EXISTS pgboss_job_exclusive_i/,
    );
    assert.match(
      schema,
      /WHERE state IN \('created', 'retry', 'active'\) AND policy = 'exclusive'/,
    );
  });
});
