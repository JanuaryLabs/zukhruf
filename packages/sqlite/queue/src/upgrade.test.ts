import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { TestClock } from 'pg-boss';

import { SqliteJobQueue } from './index.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Each job's id and state, in id order.
async function jobStates(queue: SqliteJobQueue, name: string) {
  return (await queue.findJobs(name))
    .map((job) => ({ id: job.id, state: job.state }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Each job's data, as a caller reads it.
async function jobData(queue: SqliteJobQueue, name: string) {
  return (await queue.findJobs(name)).map((job) => job.data);
}

// A queue file as the release before pg-boss's schedule kinds (text2sql
// 139a749f) left it: its queue and job tables are today's, its schedule table
// has no kind and a required next_run_on, and it has no pgboss_version. No
// public operation makes an older shape, so the schedule table and its row
// are written in that release's SQL; the queues and the job go through the
// queue.
async function scheduleTableBeforeKinds(path: string, clock: TestClock) {
  const earlier = new SqliteJobQueue({ path, clock, schedule: false });
  await earlier.start();
  await earlier.createQueue('jobs');
  await earlier.createQueue('ticks');
  await earlier.send('jobs', { n: 1 }, { id: id(1) });
  await earlier.stop({ graceful: false, close: true });
  using database = new DatabaseSync(path);
  database.exec(`DROP TABLE pgboss_version;
    DROP TABLE pgboss_schedule;
    CREATE TABLE pgboss_schedule (
      queue_name TEXT NOT NULL REFERENCES pgboss_queue(name) ON DELETE CASCADE,
      key TEXT NOT NULL,
      cron TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      data TEXT NOT NULL DEFAULT '{}',
      options TEXT NOT NULL DEFAULT '{}',
      next_run_on TEXT NOT NULL,
      created_on TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_on TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (queue_name, key)
    );
    INSERT INTO pgboss_schedule
      (queue_name, key, cron, timezone, data, options, next_run_on, updated_on)
      VALUES ('ticks', '', '* * * * *', 'UTC', '{"from":"earlier"}', '{}',
        '2026-01-01T00:01:00.000Z', '2026-01-01T00:00:00.000Z')`);
}

describe('a queue file an earlier release made', () => {
  it(
    'runs the job and fires the schedule that the earlier release stored',
    { todo: '#2859 start() skips a stale table' },
    async () => {
      await using scratch = await mkdtempDisposable(join(tmpdir(), 'queue-'));
      const path = join(scratch.path, 'queue.sqlite');
      const clock = new TestClock('2026-01-01T00:00:30.000Z');
      await scheduleTableBeforeKinds(path, clock);
      const queue = new SqliteJobQueue({ path, clock, supervise: false });
      const errors: string[] = [];
      queue.on('error', (error) => errors.push(error.message));
      try {
        await queue.start();
        const ran: string[] = [];
        await queue.work('jobs', async (jobs) => {
          ran.push(...jobs.map((job) => job.id));
        });
        await clock.tick(30_000);
        await clock.tick(2000);

        assert.deepEqual(ran, [id(1)]);
        // The first occurrence it sends; how many come due is the timekeeper's.
        const [fired] = await jobData(queue, 'ticks');
        assert.deepEqual(fired, { from: 'earlier' });
        assert.deepEqual(errors, []);
      } finally {
        await queue.stop({ graceful: false, close: true });
      }
    },
  );

  it(
    'runs the job that a release before the monitor columns stored, in a queue it made',
    { todo: '#2859 start() skips a stale table' },
    async () => {
      await using scratch = await mkdtempDisposable(join(tmpdir(), 'queue-'));
      const path = join(scratch.path, 'queue.sqlite');
      const clock = new TestClock('2026-01-01T00:00:00.000Z');
      {
        // The queue and job tables as text2sql 4caf2db1 made them, with a
        // queue and a job as its createQueue() and send() stored them. No
        // public operation makes an older shape, so they are written in that
        // release's SQL.
        using database = new DatabaseSync(path);
        database.exec(`CREATE TABLE pgboss_queue (
        name TEXT PRIMARY KEY,
        policy TEXT NOT NULL DEFAULT 'standard',
        retry_limit INTEGER NOT NULL DEFAULT 2 CHECK (retry_limit >= 0),
        retry_delay_seconds INTEGER NOT NULL DEFAULT 0 CHECK (retry_delay_seconds >= 0),
        retry_backoff INTEGER NOT NULL DEFAULT 0 CHECK (retry_backoff IN (0, 1)),
        retry_delay_max_seconds INTEGER CHECK (retry_delay_max_seconds IS NULL OR retry_delay_max_seconds >= 0),
        expire_seconds INTEGER NOT NULL DEFAULT 900 CHECK (expire_seconds >= 1),
        retention_seconds INTEGER NOT NULL DEFAULT 1209600 CHECK (retention_seconds >= 1),
        deletion_seconds INTEGER NOT NULL DEFAULT 604800 CHECK (deletion_seconds >= 0),
        heartbeat_seconds INTEGER CHECK (heartbeat_seconds IS NULL OR heartbeat_seconds >= 10),
        dead_letter TEXT REFERENCES pgboss_queue(name),
        warning_queue_size INTEGER NOT NULL DEFAULT 0 CHECK (warning_queue_size >= 0),
        notify INTEGER NOT NULL DEFAULT 0 CHECK (notify IN (0, 1)),
        created_on TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_on TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE pgboss_job (
        id TEXT NOT NULL,
        queue_name TEXT NOT NULL REFERENCES pgboss_queue(name) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL DEFAULT 'created' CHECK (state IN ('created', 'retry', 'active', 'completed', 'cancelled', 'failed')),
        policy TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        retry_limit INTEGER NOT NULL DEFAULT 2 CHECK (retry_limit >= 0),
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        retry_delay_seconds INTEGER NOT NULL DEFAULT 0 CHECK (retry_delay_seconds >= 0),
        retry_backoff INTEGER NOT NULL DEFAULT 0 CHECK (retry_backoff IN (0, 1)),
        retry_delay_max_seconds INTEGER CHECK (retry_delay_max_seconds IS NULL OR retry_delay_max_seconds >= 0),
        start_after TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        singleton_key TEXT,
        singleton_on TEXT,
        expire_seconds INTEGER NOT NULL DEFAULT 900 CHECK (expire_seconds >= 1),
        retention_seconds INTEGER NOT NULL DEFAULT 1209600 CHECK (retention_seconds >= 1),
        deletion_seconds INTEGER NOT NULL DEFAULT 604800 CHECK (deletion_seconds >= 0),
        heartbeat_seconds INTEGER CHECK (heartbeat_seconds IS NULL OR heartbeat_seconds >= 10),
        heartbeat_on TEXT,
        lease_expires_on TEXT,
        created_on TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_on TEXT,
        completed_on TEXT,
        keep_until TEXT,
        cancelled_on TEXT,
        failed_on TEXT,
        output TEXT,
        error TEXT,
        dead_letter TEXT REFERENCES pgboss_queue(name),
        group_id TEXT,
        group_tier TEXT,
        source_name TEXT,
        source_id TEXT,
        source_created_on TEXT,
        source_retry_count INTEGER,
        source_output TEXT,
        source_root_id TEXT,
        PRIMARY KEY (queue_name, id)
      );
      INSERT INTO pgboss_queue (name) VALUES ('jobs');
      INSERT INTO pgboss_job
        (id, queue_name, data, policy, start_after, created_on, keep_until)
        VALUES ('${id(1)}', 'jobs', '{"n":1}', 'standard',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
          '2026-01-15T00:00:00.000Z')`);
      }
      const queue = new SqliteJobQueue({ path, clock, schedule: false });
      const errors: string[] = [];
      queue.on('error', (error) => errors.push(error.message));
      try {
        await queue.start();
        const ran: string[] = [];
        await queue.work('jobs', async (jobs) => {
          ran.push(...jobs.map((job) => job.id));
        });
        await clock.tick(2000);

        assert.deepEqual(ran, [id(1)]);
        assert.deepEqual(errors, []);
      } finally {
        await queue.stop({ graceful: false, close: true });
      }
    },
  );

  it(
    'stores a new schedule and fires it on the clock',
    { todo: '#2859 start() skips a stale table' },
    async () => {
      await using scratch = await mkdtempDisposable(join(tmpdir(), 'queue-'));
      const path = join(scratch.path, 'queue.sqlite');
      const clock = new TestClock('2026-01-01T00:00:30.000Z');
      await scheduleTableBeforeKinds(path, clock);
      const queue = new SqliteJobQueue({ path, clock, supervise: false });
      try {
        await queue.start();
        await queue.createQueue('reports');
        await queue.schedule('reports', '* * * * *', { from: 'today' });
        await clock.tick(30_000);
        await clock.tick(2000);

        const [fired] = await jobData(queue, 'reports');
        assert.deepEqual(fired, { from: 'today' });
      } finally {
        await queue.stop({ graceful: false, close: true });
      }
    },
  );

  it(
    'keeps a job queued while its key runs on a singleton queue whose index an earlier release made without UNIQUE',
    { todo: '#2271 start() skips a stale index' },
    async () => {
      await using scratch = await mkdtempDisposable(join(tmpdir(), 'queue-'));
      const path = join(scratch.path, 'queue.sqlite');
      const clock = new TestClock('2026-01-01T00:00:00.000Z');
      const earlier = new SqliteJobQueue({ path, clock, schedule: false });
      await earlier.start();
      await earlier.stop({ graceful: false, close: true });
      {
        // The singleton index as text2sql 98d1eda8 made it. No public
        // operation makes an older shape, so it is written in that release's
        // SQL.
        using database = new DatabaseSync(path);
        database.exec(`DROP INDEX pgboss_job_singleton_i;
        CREATE INDEX pgboss_job_singleton_i
          ON pgboss_job (queue_name, singleton_key)
          WHERE singleton_key IS NOT NULL`);
      }
      const queue = new SqliteJobQueue({ path, clock, schedule: false });
      const release = Promise.withResolvers<void>();
      try {
        await queue.start();
        await queue.createQueue('singles', { policy: 'singleton' });
        await queue.send('singles', null, { id: id(1), singletonKey: 'k' });
        const firstStarted = Promise.withResolvers<void>();
        await queue.work('singles', { localConcurrency: 2 }, async () => {
          firstStarted.resolve();
          await release.promise;
        });
        await firstStarted.promise;
        await queue.send('singles', null, { id: id(2), singletonKey: 'k' });
        // The idle slot tries to claim the queued job while the key runs.
        await clock.tick(2000);

        assert.deepEqual(await jobStates(queue, 'singles'), [
          { id: id(1), state: 'active' },
          { id: id(2), state: 'created' },
        ]);
      } finally {
        release.resolve();
        await queue.stop({ graceful: false, close: true });
      }
    },
  );
});
