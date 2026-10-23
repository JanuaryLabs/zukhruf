import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { type Job, TestClock } from 'pg-boss';

import { SqliteJobQueue } from './index.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error('Timed out waiting for condition');
}

// Lets what a tick fired finish: SQLite's fetch waits one event-loop turn.
async function settle(clock: TestClock) {
  await clock.tick(0);
  await new Promise((resolve) => setTimeout(resolve, 20));
}

// Job data is unknown to the queue; a test reads back a field it sent.
const field = (data: unknown, key: string): unknown =>
  typeof data === 'object' && data !== null
    ? Reflect.get(data, key)
    : undefined;

describe('SqliteJobQueue', () => {
  it('snapshots queue defaults and returns null for active exclusive duplicates', async () => {
    const queue = new SqliteJobQueue({});
    await queue.start();
    await queue.createQueue('chat-run', {
      policy: 'exclusive',
      retryLimit: 0,
      expireInSeconds: 1800,
      heartbeatSeconds: 30,
    });
    await queue.updateQueue('chat-run', {
      retryLimit: 2,
      retryDelay: 5,
    });

    const firstJobId = await queue.send(
      'chat-run',
      { streamId: 'stream-1' },
      { id: id(1), singletonKey: 'chat-1' },
    );
    const duplicateJobId = await queue.send(
      'chat-run',
      { streamId: 'stream-2' },
      { id: id(2), singletonKey: 'chat-1' },
    );
    const jobs = await queue.findJobs('chat-run', {
      key: 'chat-1',
    });

    assert.equal(firstJobId, id(1));
    assert.equal(duplicateJobId, null);
    assert.ok(firstJobId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.state, 'created');
    assert.equal(field(jobs[0]?.data, 'streamId'), 'stream-1');
    assert.equal(jobs[0]?.retryLimit, 2);
    assert.equal(jobs[0]?.retryDelay, 5);
    assert.equal(jobs[0]?.expireInSeconds, 1800);
    assert.equal(jobs[0]?.heartbeatSeconds, 30);

    await queue.cancel('chat-run', firstJobId);
    const replacementJobId = await queue.send(
      'chat-run',
      { streamId: 'stream-3' },
      { id: id(3), singletonKey: 'chat-1' },
    );

    assert.equal(replacementJobId, id(3));
    await queue.stop({ graceful: true, close: true });
  });

  it('frees exclusive slots after cancelling or failing in-flight jobs', async () => {
    const queue = new SqliteJobQueue({});
    await queue.start();
    await queue.createQueue('chat-run', {
      policy: 'exclusive',
      retryLimit: 0,
    });

    const cancelledJobId = await queue.send(
      'chat-run',
      { streamId: 'stream-1' },
      { singletonKey: 'chat-1' },
    );
    assert.ok(cancelledJobId);
    await queue.cancel('chat-run', cancelledJobId);

    const failedJobId = await queue.send(
      'chat-run',
      { streamId: 'stream-2' },
      { singletonKey: 'chat-1' },
    );
    assert.ok(failedJobId);
    await queue.fail('chat-run', failedJobId, {
      message: 'startup recovery failed active job',
    });

    const replacementJobId = await queue.send(
      'chat-run',
      { streamId: 'stream-3' },
      { id: id(3), singletonKey: 'chat-1' },
    );
    const duplicateJobId = await queue.send(
      'chat-run',
      { streamId: 'stream-4' },
      { id: id(4), singletonKey: 'chat-1' },
    );

    assert.equal(replacementJobId, id(3));
    assert.equal(duplicateJobId, null);
    await queue.stop({ graceful: true, close: true });
  });

  it('claims jobs through work and completes them when the handler succeeds', async () => {
    const queue = new SqliteJobQueue({});
    await queue.start();
    await queue.createQueue('chat-run', { retryLimit: 0 });
    const jobId = await queue.send('chat-run', { streamId: 'stream-1' });
    assert.ok(jobId);
    const handledJobs: Job<unknown>[] = [];

    await queue.work('chat-run', { localConcurrency: 1 }, async (jobs) => {
      handledJobs.push(...jobs);
    });

    await waitFor(async () => {
      const [job] = await queue.findJobs('chat-run', {
        id: jobId,
      });
      return job?.state === 'completed';
    });

    assert.equal(handledJobs.length, 1);
    assert.equal(handledJobs[0]?.id, jobId);
    assert.equal(field(handledJobs[0]?.data, 'streamId'), 'stream-1');
    assert.ok(handledJobs[0]?.signal instanceof AbortSignal);
    await queue.stop({ graceful: true, close: true });
  });

  // SQLite-only: pg-boss swallows only a policy index refusing a claim and
  // surfaces every other fetch error (manager.js:1580-1586). The trigger stands
  // in for a disk failure, which no queue operation can cause on purpose.
  it('reports a claim that fails for a reason other than a policy index', async () => {
    const database = new DatabaseSync(':memory:');
    const queue = new SqliteJobQueue({ database });
    const errors: string[] = [];
    queue.on('error', (error) => errors.push(error.message));
    try {
      await queue.start();
      await queue.createQueue('jobs');
      database.exec(`CREATE TRIGGER fail_claims BEFORE UPDATE OF state
        ON pgboss_job WHEN NEW.state = 'active'
        BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
      const jobId = await queue.send('jobs', {});
      assert.ok(jobId);

      await queue.work('jobs', {}, async () => {});
      await waitFor(async () => errors.length > 0);

      const [job] = await queue.findJobs('jobs', { id: jobId });
      assert.match(errors[0] ?? '', /^disk I\/O error \(Queue: jobs, Worker: /);
      assert.equal(job?.state, 'created');
    } finally {
      await queue.stop({ graceful: false, close: true });
      database.close();
    }
  });

  // SQLite-only: after some errors (SQLITE_FULL, SQLITE_IOERR) SQLite ends the
  // transaction itself, and a ROLLBACK after that fails with "cannot rollback -
  // no transaction is active". RAISE(ROLLBACK) in the trigger ends it the same
  // way, as no queue operation can fill or break the disk on purpose.
  it('reports the original error of a claim whose transaction SQLite already rolled back', async () => {
    const database = new DatabaseSync(':memory:');
    const queue = new SqliteJobQueue({ database });
    const errors: string[] = [];
    queue.on('error', (error) => errors.push(error.message));
    try {
      await queue.start();
      await queue.createQueue('jobs');
      database.exec(`CREATE TRIGGER fail_claims BEFORE UPDATE OF state
        ON pgboss_job WHEN NEW.state = 'active'
        BEGIN SELECT RAISE(ROLLBACK, 'boom'); END`);
      const jobId = await queue.send('jobs', {});
      assert.ok(jobId);

      await queue.work('jobs', {}, async () => {});
      await waitFor(async () => errors.length > 0);

      const [job] = await queue.findJobs('jobs', { id: jobId });
      const [error] = errors;
      assert.ok(error);
      assert.match(error, /^boom \(Queue: jobs, Worker: /);
      assert.ok(job);
      assert.equal(job.state, 'created');
    } finally {
      await queue.stop({ graceful: false, close: true });
      database.close();
    }
  });

  // SQLite-only: under a frozen clock pg-boss breaks created_on ties by id,
  // which only a frozen clock exposes (its microsecond now() keeps real sends
  // apart); SQLite breaks them by send order, as the parity plan records. The
  // frozen clock stamps every send alike, as sends sharing a millisecond are.
  // SQLite-only, like the key_strict_fifo test below: pg-boss leaves
  // created_on ties to index order (node_modules/pg-boss/dist/plans.js:
  // 1954-1958), which a frozen clock cannot pin across backends; SQLite takes
  // send order (rowid), where a random id would scramble same-millisecond
  // sends (backlog #2164).
  it('runs a standard queue in send order when sends share a millisecond', async () => {
    const clock = new TestClock('2026-01-01T00:00:00.000Z');
    const queue = new SqliteJobQueue({ clock, schedule: false });
    try {
      await queue.start();
      await queue.createQueue('jobs');
      const sent = Array.from({ length: 30 }, (_, index) => index);
      for (const index of sent) {
        await queue.send('jobs', { index });
      }
      const ran: unknown[] = [];

      await queue.work('jobs', {}, async ([job]) => {
        ran.push(field(job?.data, 'index') ?? -1);
      });
      for (let polls = 0; polls < 60 && ran.length < sent.length; polls++) {
        await clock.tick(2000);
      }

      assert.deepEqual(ran, sent);
    } finally {
      await queue.stop({ graceful: false, close: true });
    }
  });

  it('runs a key_strict_fifo key in send order when sends share a millisecond', async () => {
    const clock = new TestClock('2026-01-01T00:00:00.000Z');
    const queue = new SqliteJobQueue({ clock });
    try {
      await queue.start();
      await queue.createQueue('fifo', { policy: 'key_strict_fifo' });
      const sent = Array.from({ length: 30 }, (_, index) => index);
      for (const index of sent) {
        await queue.send('fifo', { index }, { singletonKey: 'k' });
      }
      const ran: unknown[] = [];

      await queue.work('fifo', {}, async ([job]) => {
        ran.push(field(job?.data, 'index') ?? -1);
      });
      for (let polls = 0; polls < 60 && ran.length < sent.length; polls++) {
        await clock.tick(2000);
      }

      assert.deepEqual(ran, sent);
    } finally {
      await queue.stop({ graceful: false, close: true });
    }
  });

  // SQLite-only: the parity harness always listens. pg-boss defaults
  // useListenNotify to false (node_modules/pg-boss/dist/attorney.js:416) and
  // then never hears a NOTIFY and polls at the base interval (manager.js:
  // 928-949); the same input on pg-boss over PGlite observes [] then [job].
  it('wakes no worker and keeps the base poll when not listening for notify', async () => {
    const clock = new TestClock('2026-01-01T00:00:00.000Z');
    const queue = new SqliteJobQueue({ clock, schedule: false });
    try {
      await queue.start();
      await queue.createQueue('jobs', { notify: true });
      const ran: string[] = [];
      await queue.work('jobs', {}, async (jobs) => {
        ran.push(...jobs.map((job) => job.id));
      });
      await settle(clock);
      await queue.send('jobs', null, { id: id(1) });
      await settle(clock);
      const atSend = [...ran];
      await clock.tick(2000);
      await settle(clock);

      assert.deepEqual(atSend, []);
      assert.deepEqual(ran, [id(1)]);
    } finally {
      await queue.stop({ graceful: false, close: true });
    }
  });

  // SQLite-only: the harness starts every queue before its workers. A worker
  // registered before start() is woken by it on a notify queue, as pg-boss
  // wakes them once its listener connects (adapters/pglite.js:144-152,
  // manager.js:1144-1152); another instance's send never reaches it, since
  // SQLite's wake stays in its own process.
  it('wakes workers registered before start once it starts listening', async () => {
    const clock = new TestClock('2026-01-01T00:00:00.000Z');
    const database = new DatabaseSync(':memory:');
    const producer = new SqliteJobQueue({ database, clock, schedule: false });
    const consumer = new SqliteJobQueue({
      database,
      clock,
      schedule: false,
      useListenNotify: true,
    });
    try {
      await producer.start();
      await producer.createQueue('jobs', { notify: true });
      const ran: string[] = [];
      await consumer.work('jobs', {}, async (jobs) => {
        ran.push(...jobs.map((job) => job.id));
      });
      await settle(clock);
      await producer.send('jobs', null, { id: id(1) });
      await settle(clock);
      const beforeStart = [...ran];
      await consumer.start();
      await settle(clock);

      assert.deepEqual(beforeStart, []);
      assert.deepEqual(ran, [id(1)]);
    } finally {
      await consumer.stop({ graceful: false, close: false });
      await producer.stop({ graceful: false, close: false });
      database.close();
    }
  });

  it('runs up to localConcurrency jobs before earlier jobs finish', async () => {
    const queue = new SqliteJobQueue({});
    await queue.start();
    await queue.createQueue('chat-run', { retryLimit: 0 });
    const firstJobId = await queue.send('chat-run', { streamId: 'stream-1' });
    const secondJobId = await queue.send('chat-run', { streamId: 'stream-2' });
    assert.ok(firstJobId);
    assert.ok(secondJobId);

    const activeJobs: Job<unknown>[] = [];
    let releaseHandlers!: () => void;
    const handlersReleased = new Promise<void>((resolve) => {
      releaseHandlers = resolve;
    });

    await queue.work('chat-run', { localConcurrency: 2 }, async ([job]) => {
      assert.ok(job);
      activeJobs.push(job);
      await handlersReleased;
    });

    await waitFor(async () => activeJobs.length === 2);
    assert.deepEqual(
      activeJobs.map((job) => job.id).sort(),
      [firstJobId, secondJobId].sort(),
    );

    releaseHandlers();
    await waitFor(async () => {
      const jobs = await queue.findJobs('chat-run');
      return jobs.every((job) => job.state === 'completed');
    });
    await queue.stop({ graceful: true, close: true });
  });

  it('retries failed worker jobs until retryLimit is exhausted', async () => {
    // A retry waits for the next poll, which the test clock fires.
    const clock = new TestClock('2026-01-01T00:00:00.000Z');
    const queue = new SqliteJobQueue({ clock });
    await queue.start();
    await queue.createQueue('automation-run', {
      retryLimit: 1,
      retryDelay: 0,
    });
    const jobId = await queue.send('automation-run', { automationId: 'a-1' });
    assert.ok(jobId);
    let attempts = 0;

    await queue.work('automation-run', { localConcurrency: 1 }, async () => {
      attempts++;
      throw new Error('handler failed');
    });

    await waitFor(async () => attempts === 1);
    await clock.tick(2000);
    await waitFor(async () => {
      const [job] = await queue.findJobs('automation-run', { id: jobId });
      return job?.state === 'failed';
    });
    const [job] = await queue.findJobs('automation-run', { id: jobId });

    assert.equal(attempts, 2);
    assert.equal(job?.retryCount, 1);
    assert.partialDeepStrictEqual(job?.output, {
      name: 'Error',
      message: 'handler failed',
    });
    await queue.stop({ graceful: true, close: true });
  });

  it('finds and fails active jobs for startup recovery', async () => {
    const queue = new SqliteJobQueue({});
    await queue.start();
    await queue.createQueue('chat-run', {
      policy: 'exclusive',
      retryLimit: 0,
    });
    const jobId = await queue.send(
      'chat-run',
      { streamId: 'stream-1' },
      { singletonKey: 'chat-1' },
    );
    assert.ok(jobId);

    let resolveHandler!: () => void;
    const handlerBlocked = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });

    await queue.work('chat-run', { localConcurrency: 1 }, async () => {
      await handlerBlocked;
    });

    await waitFor(async () => {
      const [job] = await queue.findJobs('chat-run', {
        id: jobId,
      });
      return job?.state === 'active';
    });

    const inFlightJobs = await queue.findJobs('chat-run');
    assert.deepEqual(
      inFlightJobs.map((job) => ({
        id: job.id,
        streamId: field(job.data, 'streamId'),
        state: job.state,
      })),
      [{ id: jobId, streamId: 'stream-1', state: 'active' }],
    );

    await queue.fail('chat-run', jobId, {
      message:
        'Marked stale active chat-run job as failed during backend startup recovery',
      code: 'chat/recovery-stale-active-job',
    });

    const [failedJob] = await queue.findJobs('chat-run', {
      id: jobId,
    });
    assert.equal(failedJob?.state, 'failed');
    assert.deepEqual(failedJob?.output, {
      message:
        'Marked stale active chat-run job as failed during backend startup recovery',
      code: 'chat/recovery-stale-active-job',
    });

    resolveHandler();
    await queue.stop({ graceful: true, close: true });
  });

  it('upserts and deletes schedules by queue and key', async () => {
    const database = new DatabaseSync(':memory:');
    const clock = new TestClock('2026-01-01T00:00:00.000Z');
    const queue = new SqliteJobQueue({
      database,
      clock,
      schedule: false,
    });
    await queue.start();
    await queue.createQueue('automation-run');

    await queue.schedule(
      'automation-run',
      '0 * * * *',
      { automationId: 'a-1' },
      { key: 'a-1', singletonKey: 'a-1', tz: 'UTC' },
    );
    await queue.schedule(
      'automation-run',
      '15 * * * *',
      { automationId: 'a-1' },
      { key: 'a-1', singletonKey: 'a-1', tz: 'UTC' },
    );

    const row = readScheduleRow(
      database
        .prepare(
          `SELECT queue_name, key, cron, timezone, data, options
        FROM pgboss_schedule`,
        )
        .get(),
    );

    assert.deepEqual(row, {
      queue_name: 'automation-run',
      key: 'a-1',
      cron: '15 * * * *',
      timezone: 'UTC',
      data: JSON.stringify({ automationId: 'a-1' }),
      options: JSON.stringify({ key: 'a-1', singletonKey: 'a-1', tz: 'UTC' }),
    });

    let jobs = await queue.findJobs('automation-run');
    assert.equal(jobs.length, 0);

    await clock.setTime('2026-01-01T00:15:00.000Z');
    await queue.runDueSchedules();
    await queue.runDueSchedules();

    jobs = await queue.findJobs('automation-run');
    assert.equal(jobs.length, 1);
    assert.equal(field(jobs[0]?.data, 'automationId'), 'a-1');
    assert.equal(jobs[0]?.singletonKey, 'a-1');

    await queue.unschedule('automation-run', 'a-1');
    const remaining = database
      .prepare('SELECT COUNT(*) AS count FROM pgboss_schedule')
      .get();

    assert.equal(readSqliteCount(remaining), 0);
    await queue.stop({ graceful: true });
    database.close();
  });

  it('abandons a slot the process slept through instead of replaying it', async () => {
    const database = new DatabaseSync(':memory:');
    const clock = new TestClock('2026-01-01T00:00:00.000Z');
    const queue = new SqliteJobQueue({
      database,
      clock,
      schedule: false,
    });

    try {
      await queue.start();
      await queue.createQueue('automation-run');
      await queue.schedule(
        'automation-run',
        '0 */6 * * *',
        { automationId: 'a-1' },
        { key: 'a-1', singletonKey: 'a-1', tz: 'UTC' },
      );

      // Slots at 06:00 and 12:00 pass while the process is down.
      await clock.setTime('2026-01-01T14:00:00.000Z');
      await queue.runDueSchedules();

      assert.equal(
        (await queue.findJobs('automation-run')).length,
        0,
        'a slot missed by hours must not be replayed on relaunch',
      );

      const next = readScheduleNextRunOn(
        database.prepare('SELECT next_run_on FROM pgboss_schedule').get(),
      );
      assert.equal(
        new Date(next).toISOString(),
        '2026-01-01T18:00:00.000Z',
        'the cursor still advances past the abandoned slot',
      );

      // The next on-time slot fires normally.
      await clock.setTime('2026-01-01T18:00:10.000Z');
      await queue.runDueSchedules();
      assert.equal((await queue.findJobs('automation-run')).length, 1);
    } finally {
      await queue.stop({ graceful: true });
      database.close();
    }
  });
});

function readSqliteCount(value: unknown): number {
  const count = readSqliteRow(value).count;
  if (typeof count !== 'number') {
    throw new TypeError('Expected SQLite count to be a number');
  }
  return count;
}

function readScheduleNextRunOn(value: unknown): string {
  const nextRunOn = readSqliteRow(value).next_run_on;
  if (typeof nextRunOn !== 'string') {
    throw new TypeError('Expected next_run_on to be a string');
  }
  return nextRunOn;
}

function readScheduleRow(value: unknown): {
  queue_name: unknown;
  key: unknown;
  cron: unknown;
  timezone: unknown;
  data: unknown;
  options: unknown;
} {
  const row = readSqliteRow(value);
  return {
    queue_name: row.queue_name,
    key: row.key,
    cron: row.cron,
    timezone: row.timezone,
    data: row.data,
    options: row.options,
  };
}

function readSqliteRow(value: unknown): Record<string, unknown> {
  assert.ok(isSqliteRow(value));
  return value;
}

function isSqliteRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
