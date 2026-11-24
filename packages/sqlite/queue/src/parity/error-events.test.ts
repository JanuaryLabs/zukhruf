import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { untilAborted } from '@zukhruf/async';

import type { JobQueue } from '../index.ts';
import { Parity } from './parity.ts';

// Resolves with the next error event. The wait of a backend that never
// emits ends at the test's limit, when `signal` aborts.
function nextError(queue: JobQueue, signal: AbortSignal) {
  return untilAborted(
    new Promise<Error>((resolve) => queue.on('error', resolve)),
    signal,
  );
}

function describeError(error: Error) {
  const worker =
    'worker' in error && typeof error.worker === 'string' ? error.worker : '';
  return {
    isError: Error.isError(error),
    keys: Object.keys(error).sort(),
    hasStack: typeof error.stack === 'string',
    queue: 'queue' in error ? error.queue : undefined,
    message: worker
      ? error.message.replaceAll(worker, '<worker>')
      : error.message,
  };
}

describe('error events', () => {
  it('reports a worker polling a queue that does not exist as an error event', async (t) => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      const reported = nextError(queue, t.signal);
      let registration: string;
      try {
        await queue.work(
          'missing',
          { pollingIntervalSeconds: 0.5 },
          async () => {},
        );
        registration = 'registered';
      } catch (error) {
        registration = Error.isError(error) ? error.message : String(error);
      }
      return { registration, reported: describeError(await reported) };
    });

    assert.deepStrictEqual(observed, {
      registration: 'registered',
      reported: {
        isError: false,
        keys: ['code', 'message', 'queue', 'stack', 'worker'],
        hasStack: true,
        queue: 'missing',
        message:
          'Queue missing does not exist (Queue: missing, Worker: <worker>)',
      },
    });
  });

  // The queue has no `notify`, so the send wakes nothing: the job runs only
  // because the worker's loop survived its failed first fetch and polled again.
  it('runs the job for a worker registered before its queue existed', async (t) => {
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
      await nextError(queue, t.signal);

      await queue.createQueue('late');
      await queue.send('late', { n: 1 }, { id: job });
      // pg-boss polls again only when the clock passes its interval.
      await clock.tick(500);
      return { ran: await untilAborted(handled.promise, t.signal) };
    });

    assert.deepStrictEqual(observed, { ran: [job] });
  });
});
