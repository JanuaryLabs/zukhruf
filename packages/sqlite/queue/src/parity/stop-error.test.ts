import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { PGlite } from '@electric-sql/pglite';
import { PgBoss, fromPglite } from 'pg-boss';

import { type JobQueue, SqliteJobQueue } from '../index.ts';

// A queue with no 'error' listener. Its queue is deleted under a running
// batch, a graceful stop starts, and then the batch ends: its settle throws
// (manager.js:411), the worker's error emit throws with no listener, and the
// worker's loop rejects while the stop waits for it (worker.js:77, 113).
// The observation: what stop() did, and how many rejections nobody handled.
async function stopUnderWorkerError(queue: JobQueue) {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await queue.start();
    await queue.createQueue('jobs');
    await queue.send('jobs', { n: 1 });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await queue.work('jobs', async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;
    await queue.deleteQueue('jobs');
    const stopping = queue.stop({
      graceful: true,
      close: false,
      timeout: 5000,
    });
    // Without useListenNotify, both stops reach worker.stop() in microtasks,
    // with no I/O before it (index.js:228-229, notifier.js:66-79,
    // manager.js:866-875), so after one turn of the event loop the worker is
    // stopping. No public event says so: wip is not emitted after a stop.
    await setImmediate();
    release.resolve();
    let stop: string;
    try {
      await stopping;
      stop = 'resolved';
    } catch (error) {
      stop = `rejected: ${String(error)}`;
    }
    // A graceful stop resolves after the worker's loop settled
    // (index.js:269), and Node reports a rejection nobody handled at the
    // end of the turn it settled in, before the next turn runs.
    await setImmediate();
    return { stop, unhandled: unhandled.length };
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

describe('stop with no error listener', () => {
  it('resolves, and leaves no unhandled rejection when a stopping worker fails to settle, as pg-boss does', async () => {
    const pglite = new PGlite();
    const pgBoss = await stopUnderWorkerError(
      new PgBoss({
        backend: 'pglite',
        db: fromPglite(pglite),
        schedule: false,
      }),
    ).finally(() => pglite.close());

    const queue = new SqliteJobQueue({ schedule: false });
    const sqlite = await stopUnderWorkerError(queue).finally(() =>
      queue.stop({ close: true }),
    );

    assert.deepStrictEqual(sqlite, pgBoss);
    assert.deepStrictEqual(pgBoss, { stop: 'resolved', unhandled: 0 });
  });
});
