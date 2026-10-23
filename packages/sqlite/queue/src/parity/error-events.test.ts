import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import type { JobQueue } from '../index.ts';
import { Parity } from './parity.ts';

// Resolves with the next error event, or null after `ms` so a backend that
// never emits fails the comparison instead of hanging.
async function nextError(queue: JobQueue, ms: number) {
  const reported = new Promise<Error>((resolve) => queue.on('error', resolve));
  const timeout = new AbortController();
  try {
    return await Promise.race([
      reported,
      sleep(ms, null, { signal: timeout.signal }).catch(() => null),
    ]);
  } finally {
    timeout.abort();
  }
}

function describeError(error: Error) {
  const worker =
    'worker' in error && typeof error.worker === 'string' ? error.worker : '';
  return {
    isError: error instanceof Error,
    keys: Object.keys(error).sort(),
    hasStack: typeof error.stack === 'string',
    queue: 'queue' in error ? error.queue : undefined,
    message: worker
      ? error.message.replaceAll(worker, '<worker>')
      : error.message,
  };
}

describe('error events', () => {
  it('reports a worker polling a queue that does not exist as an error event', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      const reported = nextError(queue, 5000);
      let registration: string;
      try {
        await queue.work(
          'missing',
          { pollingIntervalSeconds: 0.5 },
          async () => {},
        );
        registration = 'registered';
      } catch (error) {
        registration = error instanceof Error ? error.message : String(error);
      }
      const error = await reported;
      return {
        registration,
        reported: error === null ? 'none within 5s' : describeError(error),
      };
    });

    assert.deepStrictEqual(observed, {
      registration: 'registered',
      reported: {
        isError: false,
        keys: ['message', 'queue', 'stack', 'worker'],
        hasStack: true,
        queue: 'missing',
        message:
          'Queue missing does not exist (Queue: missing, Worker: <worker>)',
      },
    });
  });

  // The queue has no `notify`, so the send wakes nothing: the job runs only
  // because the worker's loop survived its failed first fetch and polled again.
  it('runs the job for a worker registered before its queue existed', async () => {
    const job = '00000000-0000-4000-8000-000000000001';

    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      const handled = Promise.withResolvers<string[]>();
      await queue.work(
        'late',
        { pollingIntervalSeconds: 0.5 },
        async (jobs) => {
          handled.resolve(jobs.map(({ id }) => id));
        },
      );
      // work() resolves before its first fetch fails, so the error is still
      // ahead of a listener attached now.
      const failedPoll = await nextError(queue, 5000);

      await queue.createQueue('late');
      await queue.send('late', { n: 1 }, { id: job });
      // pg-boss polls again only when the clock passes its interval.
      await clock.tick(500);
      const timeout = new AbortController();
      try {
        const ran = await Promise.race([
          handled.promise,
          sleep(5000, null, { signal: timeout.signal }).catch(() => null),
        ]);
        return { failedPoll: failedPoll !== null, ran };
      } finally {
        timeout.abort();
      }
    });

    assert.deepStrictEqual(observed, { failedPoll: true, ran: [job] });
  });
});
