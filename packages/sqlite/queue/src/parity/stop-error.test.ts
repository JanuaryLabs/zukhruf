import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';

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
    // pg-boss closes its listener before its workers stop
    // (node_modules/pg-boss/dist/index.js:227-231); nothing tells when the
    // worker is stopping, so the batch ends after a pause.
    await setTimeout(200);
    release.resolve();
    let stop: string;
    try {
      await stopping;
      stop = 'resolved';
    } catch (error) {
      stop = `rejected: ${String(error)}`;
    }
    // A rejection nobody handled is reported after the turn it settled in.
    await setTimeout(50);
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
