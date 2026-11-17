import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createClock } from '@sinonjs/fake-timers';

import { Latch } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { SqliteJobQueue } from '@zukhruf/sqlite-queue';
import { describe, test } from '@zukhruf/testing/node';

import {
  Fixed,
  NoEviction,
  Parallel,
  PoolWorkers,
  type Worker,
  WorkerKind,
} from './index.ts';

// The longest wait for a fact that should hold at once; it bounds a broken
// run and asserts no speed.
const factTimeout = 10_000;

// The queue of the kind "echo", revision 1.
const queue = 'echo.r1';

describe('PoolWorkers rest', () => {
  test('two jobs that end together free both slots for the next two jobs, with no wait for the backstop', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const clock = createClock(Date.now());
    const answers = new Map<string, () => void>();
    let created = 0;
    class HeldWorker implements Worker<{ id: string }, { id: string }> {
      readonly #exit = new Latch();
      run(input: { id: string }): Promise<{ id: string }> {
        const answered = Promise.withResolvers<{ id: string }>();
        answers.set(input.id, () => answered.resolve(input));
        return answered.promise;
      }
      exited(): Promise<void> {
        return this.#exit.wait();
      }
      kill(): void {
        this.#exit.open();
      }
      async close(): Promise<void> {
        this.#exit.open();
      }
    }
    const owner = new PoolWorkers({
      kind: new WorkerKind<{ id: string }, { id: string }>({
        name: 'echo',
        revision: 1,
        policy: 'standard',
        retryLimit: 0,
        expireInSeconds: 60,
      }),
      store,
      clock,
      create: () => {
        created++;
        return new HeldWorker();
      },
      size: new Fixed(2),
      startup: new Parallel(),
      eviction: new NoEviction(),
    });
    const jobs = await new SqliteJobQueue({
      path: store,
      supervise: false,
      schedule: false,
    }).start();
    try {
      await t.waitFor(() => assert.ok(created > 0, 'the owner'), {
        interval: 5,
        timeout: factTimeout,
      });
      await jobs.send(queue, { input: { id: 'a' } });
      await jobs.send(queue, { input: { id: 'b' } });
      // The backstop fetches a and b, which no wake told of.
      await clock.tickAsync(1_000);
      await t.waitFor(() => assert.deepEqual([...answers.keys()], ['a', 'b']), {
        interval: 5,
        timeout: factTimeout,
      });
      await jobs.send(queue, { input: { id: 'c' } });
      await jobs.send(queue, { input: { id: 'd' } });

      answers.get('a')!();
      answers.get('b')!();

      // The fake clock stands still: only the ends of a and b can wake the owner.
      await t.waitFor(
        () => assert.deepEqual([...answers.keys()], ['a', 'b', 'c', 'd']),
        { interval: 5, timeout: factTimeout },
      );
    } finally {
      for (const answer of answers.values()) answer();
      await owner[Symbol.asyncDispose]();
      await jobs.stop();
    }
  });
});
