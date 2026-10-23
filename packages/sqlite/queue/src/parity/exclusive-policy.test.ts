import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Parity } from './parity.ts';

describe('exclusive policy', () => {
  it('refuses a second job for a key while the first is queued or running, and takes one after cancel', async () => {
    const first = '00000000-0000-4000-8000-000000000001';
    const duplicate = '00000000-0000-4000-8000-000000000002';
    const replacement = '00000000-0000-4000-8000-000000000003';

    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('chat-run', { policy: 'exclusive' });
      const queued = await queue.send(
        'chat-run',
        { chatId: 'chat-1' },
        { id: first, singletonKey: 'chat-1' },
      );
      const whileQueued = await queue.send(
        'chat-run',
        { chatId: 'chat-1' },
        { id: duplicate, singletonKey: 'chat-1' },
      );

      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      await queue.work('chat-run', {}, async () => {
        started.resolve();
        await finish.promise;
      });
      try {
        await started.promise;
        const whileRunning = await queue.send(
          'chat-run',
          { chatId: 'chat-1' },
          { id: duplicate, singletonKey: 'chat-1' },
        );
        await queue.cancel('chat-run', first);
        const afterCancel = await queue.send(
          'chat-run',
          { chatId: 'chat-1' },
          { id: replacement, singletonKey: 'chat-1' },
        );
        const jobs = (await queue.findJobs('chat-run'))
          .map((job) => ({ id: job.id, state: job.state }))
          .sort((a, b) => a.id.localeCompare(b.id));

        // The cancelled job's handler now returns: settling it must not
        // resurrect the job. Graceful stop waits for that settle.
        finish.resolve();
        await queue.stop({ graceful: true, close: false });
        const [cancelled] = await queue.findJobs('chat-run', { id: first });
        return {
          queued,
          whileQueued,
          whileRunning,
          afterCancel,
          jobs,
          afterHandler: cancelled?.state,
        };
      } finally {
        finish.resolve();
      }
    });

    assert.deepStrictEqual(observed, {
      queued: first,
      whileQueued: null,
      whileRunning: null,
      afterCancel: replacement,
      jobs: [
        { id: first, state: 'cancelled' },
        { id: replacement, state: 'created' },
      ],
      afterHandler: 'cancelled',
    });
  });
});
