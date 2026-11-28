import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { type Job, TestClock } from 'pg-boss';

import { untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { type Notification, Notifications } from '@zukhruf/sqlite-notify';
import { open } from '@zukhruf/sqlite-open';
import { waitFor } from '@zukhruf/testing/async';

import {
  SqliteJobQueue,
  SqliteJobQueueWarning,
  TimekeeperWarning,
} from './index.ts';
import { DateFollowsClock } from './testing/date-follows-clock.ts';
import { id } from './testing/job-id.ts';

// Lets what a tick fired finish: SQLite's fetch waits one event-loop turn.
async function settle(clock: TestClock) {
  await clock.tick(0);
  await setImmediate();
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

  it('claims jobs through work and completes them when the handler succeeds', async (t) => {
    const queue = new SqliteJobQueue({});
    await queue.start();
    await queue.createQueue('chat-run', { retryLimit: 0 });
    const jobId = await queue.send('chat-run', { streamId: 'stream-1' });
    assert.ok(jobId);
    const handledJobs: Job<unknown>[] = [];

    await queue.work('chat-run', { localConcurrency: 1 }, async (jobs) => {
      handledJobs.push(...jobs);
    });

    await waitFor(
      async () => {
        const [job] = await queue.findJobs('chat-run', {
          id: jobId,
        });
        assert.equal(job?.state, 'completed');
      },
      { signal: t.signal, interval: 5 },
    );

    assert.equal(handledJobs.length, 1);
    assert.equal(handledJobs[0]?.id, jobId);
    assert.equal(field(handledJobs[0]?.data, 'streamId'), 'stream-1');
    assert.ok(handledJobs[0]?.signal instanceof AbortSignal);
    await queue.stop({ graceful: true, close: true });
  });

  // SQLite-only: pg-boss swallows only a policy index refusing a claim and
  // surfaces every other fetch error (manager.js:2104-2110). The trigger stands
  // in for a disk failure, which no queue operation can cause on purpose.
  it('reports a claim that fails for a reason other than a policy index', async (t) => {
    const database = open(':memory:');
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
      await waitFor(() => assert.notEqual(errors.length, 0), {
        signal: t.signal,
        interval: 5,
      });

      const [job] = await queue.findJobs('jobs', { id: jobId });
      assert.match(errors[0] ?? '', /^disk I\/O error \(Queue: jobs, Worker: /);
      assert.equal(job?.state, 'created');
    } finally {
      await queue.stop({ graceful: false, close: true });
      database.close();
    }
  });

  // SQLite-only: a lookup here reads the live row, so pg-boss has no fault that
  // fails its refresh and spares the lookups; one row no refresh can read
  // does that here. onCacheQueues keeps the cache when a refresh fails
  // (node_modules/pg-boss/dist/manager.js:1049-1058), and a worker bursts on
  // the counts the cache held (1207-1222).
  it('keeps the queue cache it held when a refresh fails, so a worker still bursts on its counts', async () => {
    const database = open(':memory:');
    const clock = new TestClock('2026-01-01T00:00:00.000Z');
    const queue = new SqliteJobQueue({
      database,
      clock,
      schedule: false,
      supervise: true,
      superviseIntervalSeconds: 1,
      // One count, at 1000, before the minute runs out.
      monitorIntervalSeconds: 60,
      maintenanceIntervalSeconds: 1,
      queueCacheIntervalSeconds: 1,
    });
    const errors: string[] = [];
    queue.on('error', (error) => errors.push(error.message));
    try {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.createQueue('other');
      for (const n of [1, 2, 3, 4, 5]) {
        await queue.send('jobs', null, { id: id(n) });
      }
      // The pass at 1000 counts 5 ready; the refresh at 2000 caches them.
      await clock.tick(2000);
      // The row now says none are ready, which a refresh or a lookup that
      // missed the cache would read; only the counts the cache held burst.
      database.exec(`UPDATE pgboss_queue SET ready_count = 0 WHERE name = 'jobs';
        UPDATE pgboss_queue SET retry_limit = 'x' WHERE name = 'other'`);
      await clock.tick(1000);
      const claims: string[][] = [];
      await queue.work('jobs', { burstWhenReadyExceeds: 1 }, async (jobs) => {
        claims.push(jobs.map((job) => job.id));
      });
      await clock.tick(0);

      assert.notEqual(errors.length, 0);
      assert.deepStrictEqual(
        claims,
        [1, 2, 3, 4, 5].map((n) => [id(n)]),
      );
    } finally {
      await queue.stop({ graceful: false, close: true });
      database.close();
    }
  });

  // SQLite-only: after some errors (SQLITE_FULL, SQLITE_IOERR) SQLite ends the
  // transaction itself, and a ROLLBACK after that fails with "cannot rollback -
  // no transaction is active". RAISE(ROLLBACK) in the trigger ends it the same
  // way, as no queue operation can fill or break the disk on purpose.
  it('reports the original error of a claim whose transaction SQLite already rolled back', async (t) => {
    const database = open(':memory:');
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
      await waitFor(() => assert.notEqual(errors.length, 0), {
        signal: t.signal,
        interval: 5,
      });

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
  // 2491-2495), which a frozen clock cannot pin across backends; SQLite takes
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
  // useListenNotify to false (node_modules/pg-boss/dist/attorney.js:419) and
  // then never hears a NOTIFY and polls at the base interval (manager.js:
  // 1182-1203); the same input on pg-boss over PGlite observes [] then [job].
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
  // manager.js:1590-1598); in memory, another instance's send never reaches
  // it, since only a file has the notifications of @zukhruf/sqlite-notify.
  it('wakes workers registered before start once it starts listening', async () => {
    const clock = new TestClock('2026-01-01T00:00:00.000Z');
    const database = open(':memory:');
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

  // A pg-boss listener hears the NOTIFY of its own instance
  // (notifier.js:58). On a file the notification goes through
  // @zukhruf/sqlite-notify, and the instance that sent it hears it too,
  // before its poll. The poll here is an hour, also when the queue does not
  // listen (attorney.js:641, 655): longer than the test runner lets a test run
  // (--test-timeout), so only the notification can run the second job before
  // the test ends.
  // stop() awaits the close of the listener before it clears its intervals
  // (manager.js:1126-1129). On a file that close is I/O of
  // @zukhruf/sqlite-notify, so a TestClock must wait for it, or it fires the
  // wip interval that the stop is about to clear (#4984).
  it('clears the wip interval of a graceful stop on a file before the clock fires it', async () => {
    await using dir = await new TemporaryFiles().directory('sqlite-queue-');
    const clock = new TestClock('2026-01-01T00:00:00.000Z');
    const queue = new SqliteJobQueue({
      path: join(dir.path, 'queue.db'),
      schedule: false,
      supervise: false,
      clock,
      useListenNotify: true,
    });
    const wip: string[][] = [];
    queue.on('wip', (workers) => {
      wip.push(workers.map((worker) => worker.state));
    });
    const release = Promise.withResolvers<void>();
    await queue.start();
    try {
      await queue.createQueue('jobs');
      await queue.work(
        'jobs',
        { pollingIntervalSeconds: 2.5 },
        () => release.promise,
      );
      await queue.send('jobs', null, { id: id(1) });
      await clock.tick(2500);

      const stopping = queue.stop({ graceful: true, close: false });
      await clock.tick(3600);
      release.resolve();
      await stopping;

      // The batch's start, then its end from a worker now stopping, and no
      // emit of the interval at 6000 between them.
      assert.deepStrictEqual(wip, [['active'], ['stopping']]);
    } finally {
      release.resolve();
      await queue.stop({ graceful: false, close: true });
    }
  });

  it('wakes its own waiting worker when it sends to a notify queue on a file', async (t) => {
    await using dir = await new TemporaryFiles().directory('sqlite-queue-');
    const queue = new SqliteJobQueue({
      path: join(dir.path, 'queue.db'),
      useListenNotify: true,
    });
    await queue.start();
    try {
      await queue.createQueue('jobs', { notify: true });
      // The first job ends the first fetch, so the worker then waits.
      await queue.send('jobs', null, { id: id(1) });
      const first = Promise.withResolvers<void>();
      const second = Promise.withResolvers<void>();
      await queue.work(
        'jobs',
        { pollingIntervalSeconds: 3600 },
        async (jobs) => {
          for (const job of jobs) {
            if (job.id === id(1)) first.resolve();
            if (job.id === id(2)) second.resolve();
          }
        },
      );
      await untilAborted(first.promise, t.signal);

      await queue.send('jobs', null, { id: id(2) });

      await untilAborted(second.promise, t.signal);
    } finally {
      await queue.stop();
    }
  });

  // node_modules/pg-boss/dist/plans.js:1190-1192, 2999-3003: the channel is
  // 'pgboss_' and 24 hex digits of the SHA-224 of the schema 'pgboss', and the
  // payload is the name of the queue. Another program on the file, which
  // listens on that channel, hears the send.
  it("notifies pg-boss's channel with the queue name when it sends to a notify queue on a file", async (t) => {
    await using dir = await new TemporaryFiles().directory('sqlite-queue-');
    const path = join(dir.path, 'queue.db');
    const queue = new SqliteJobQueue(path);
    await queue.start();
    try {
      await queue.createQueue('jobs', { notify: true });
      await using listener = new Notifications({ path, clock: globalThis });
      const errors: unknown[] = [];
      listener.on('error', (error) => errors.push(error));
      const heard = Promise.withResolvers<Notification>();
      listener.on('notification', heard.resolve);
      await listener.listen('pgboss_454650302e472074f72063fd');

      await queue.send('jobs', null, { id: id(1) });

      const notification = await untilAborted(heard.promise, t.signal);
      assert.deepEqual(
        { channel: notification.channel, payload: notification.payload },
        { channel: 'pgboss_454650302e472074f72063fd', payload: 'jobs' },
      );
      assert.deepEqual(errors, []);
    } finally {
      await queue.stop();
    }
  });

  it('runs up to localConcurrency jobs before earlier jobs finish', async (t) => {
    const queue = new SqliteJobQueue({});
    await queue.start();
    await queue.createQueue('chat-run', { retryLimit: 0 });
    const firstJobId = await queue.send('chat-run', { streamId: 'stream-1' });
    const secondJobId = await queue.send('chat-run', { streamId: 'stream-2' });
    assert.ok(firstJobId);
    assert.ok(secondJobId);

    const activeJobs: Job<unknown>[] = [];
    const { promise: handlersReleased, resolve: releaseHandlers } =
      Promise.withResolvers<void>();

    await queue.work('chat-run', { localConcurrency: 2 }, async ([job]) => {
      assert.ok(job);
      activeJobs.push(job);
      await handlersReleased;
    });

    await waitFor(() => assert.equal(activeJobs.length, 2), {
      signal: t.signal,
      interval: 5,
    });
    assert.deepEqual(
      activeJobs.map((job) => job.id).sort(),
      [firstJobId, secondJobId].sort(),
    );

    releaseHandlers();
    await waitFor(
      async () => {
        const jobs = await queue.findJobs('chat-run');
        assert.ok(jobs.every((job) => job.state === 'completed'));
      },
      { signal: t.signal, interval: 5 },
    );
    await queue.stop({ graceful: true, close: true });
  });

  it('retries failed worker jobs until retryLimit is exhausted', async (t) => {
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

    await waitFor(() => assert.equal(attempts, 1), {
      signal: t.signal,
      interval: 5,
    });
    await clock.tick(2000);
    await waitFor(
      async () => {
        const [job] = await queue.findJobs('automation-run', { id: jobId });
        assert.equal(job?.state, 'failed');
      },
      { signal: t.signal, interval: 5 },
    );
    const [job] = await queue.findJobs('automation-run', { id: jobId });

    assert.equal(attempts, 2);
    assert.equal(job?.retryCount, 1);
    assert.partialDeepStrictEqual(job?.output, {
      name: 'Error',
      message: 'handler failed',
    });
    await queue.stop({ graceful: true, close: true });
  });

  it('finds and fails active jobs for startup recovery', async (t) => {
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

    const { promise: handlerBlocked, resolve: resolveHandler } =
      Promise.withResolvers<void>();

    await queue.work('chat-run', { localConcurrency: 1 }, async () => {
      await handlerBlocked;
    });

    await waitFor(
      async () => {
        const [job] = await queue.findJobs('chat-run', {
          id: jobId,
        });
        assert.equal(job?.state, 'active');
      },
      { signal: t.signal, interval: 5 },
    );

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

  // SQLite-only: pg-boss drops an 'error' event that nobody listens for in
  // its send-it worker (ADR 0003).
  it("reports a forward that its queue refuses, with no 'error' listener, as a TimekeeperWarning with its code, the schedule and the refusal as its cause", async () => {
    // Arrange
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => {
      if (warning.name === 'TimekeeperWarning') warnings.push(warning);
    };
    process.on('warning', onWarning);
    const clock = new TestClock('2026-01-01T00:00:00.000Z');
    using _date = new DateFollowsClock(clock);
    const queue = new SqliteJobQueue({
      clock,
      schedule: true,
      supervise: false,
    });
    try {
      await queue.start();
      await clock.tick(0);
      await queue.createQueue('fifo', { policy: 'key_strict_fifo' });
      await queue.schedule('fifo', '* * * * *');

      // Act: the cron pass at 30 s files the occurrence, and the send-it
      // worker forwards it to a queue that refuses a job with no key.
      await clock.tick(30_000);
      await setImmediate();

      // Assert
      const [warning] = warnings;
      assert.equal(warnings.length, 1);
      assert.ok(warning instanceof TimekeeperWarning);
      assert.deepEqual(
        { ...warning, message: warning.message },
        {
          name: 'TimekeeperWarning',
          code: 'ZUKHRUF_SQLITE_QUEUE_SEND_IT_UNREPORTED',
          detail: 'schedule: fifo\nkey: ',
          message:
            "A send-it job failed, and no 'error' listener took the failure: key_strict_fifo queues require a singletonKey",
        },
      );
      assert.ok(Error.isError(warning.cause));
      assert.equal(
        warning.cause.message,
        'key_strict_fifo queues require a singletonKey',
      );
    } finally {
      process.off('warning', onWarning);
      await queue.stop({ graceful: false, close: true });
    }
  });

  // SQLite-only: pg-boss's stop lets the error of failWip escape (ADR 0003).
  it("reports a stop that fails to fail a worker's active jobs, with no 'error' listener, as a SqliteJobQueueWarning with its code, the queue and the worker, and the failure as its cause", async () => {
    // Arrange: the queue is deleted under the worker's running job, so the
    // stop's fail of that job finds no queue.
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => {
      if (warning.name === 'SqliteJobQueueWarning') warnings.push(warning);
    };
    process.on('warning', onWarning);
    const queue = new SqliteJobQueue({ schedule: false, supervise: false });
    const release = Promise.withResolvers<void>();
    try {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', { n: 1 });
      const started = Promise.withResolvers<void>();
      const worker = await queue.work('jobs', async () => {
        started.resolve();
        await release.promise;
      });
      await started.promise;
      await queue.deleteQueue('jobs');

      // Act
      await queue.stop({ graceful: false, close: false });
      await setImmediate();

      // Assert
      const [warning] = warnings;
      assert.equal(warnings.length, 1);
      assert.ok(warning instanceof SqliteJobQueueWarning);
      assert.deepEqual(
        { ...warning, message: warning.message },
        {
          name: 'SqliteJobQueueWarning',
          code: 'ZUKHRUF_SQLITE_QUEUE_STOP_FAIL_UNHEARD',
          detail: `queue: jobs\nworker: ${worker}`,
          message:
            "The fail of a worker's active jobs at stop failed, and nobody listens for 'error': Queue jobs does not exist",
        },
      );
      assert.ok(Error.isError(warning.cause));
      assert.equal(warning.cause.message, 'Queue jobs does not exist');
    } finally {
      release.resolve();
      process.off('warning', onWarning);
      await queue.stop({ graceful: false, close: true });
    }
  });

  it("reports an 'error' listener that throws on a stop's failed fail of a worker's active jobs as a SqliteJobQueueWarning with its code, the queue and the worker, and the listener's error as its cause", async () => {
    // Arrange: the queue is deleted under the worker's running job, and the
    // host's 'error' listener throws.
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => {
      if (warning.name === 'SqliteJobQueueWarning') warnings.push(warning);
    };
    process.on('warning', onWarning);
    const queue = new SqliteJobQueue({ schedule: false, supervise: false });
    const listenerError = new Error('The error listener of the host broke');
    queue.on('error', () => {
      throw listenerError;
    });
    const release = Promise.withResolvers<void>();
    try {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', { n: 1 });
      const started = Promise.withResolvers<void>();
      const worker = await queue.work('jobs', async () => {
        started.resolve();
        await release.promise;
      });
      await started.promise;
      await queue.deleteQueue('jobs');

      // Act
      await queue.stop({ graceful: false, close: false });
      await setImmediate();

      // Assert
      const [warning] = warnings;
      assert.equal(warnings.length, 1);
      assert.ok(warning instanceof SqliteJobQueueWarning);
      assert.deepEqual(
        { ...warning, message: warning.message },
        {
          name: 'SqliteJobQueueWarning',
          code: 'ZUKHRUF_SQLITE_QUEUE_ERROR_LISTENER_THREW',
          detail: `queue: jobs\nworker: ${worker}`,
          message:
            "The fail of a worker's active jobs at stop failed, and an 'error' listener threw: The error listener of the host broke",
        },
      );
      assert.equal(warning.cause, listenerError);
    } finally {
      release.resolve();
      process.off('warning', onWarning);
      await queue.stop({ graceful: false, close: true });
    }
  });
});
