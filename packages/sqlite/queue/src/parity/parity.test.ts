import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Parity } from './parity.ts';

describe('Parity', () => {
  it('runs the scenario on both backends and resolves to the shared observation', async () => {
    const queues: string[] = [];

    const observed = await Parity.assertSame(async ({ queue }) => {
      queues.push(queue.constructor.name);
      return { value: 1 };
    });

    assert.deepStrictEqual(observed, { value: 1 });
    assert.deepStrictEqual(queues, ['PgBoss', 'SqliteJobQueue']);
  });

  it('rejects with the deep-equal diff when one field differs between backends', async () => {
    await assert.rejects(
      Parity.assertSame(async ({ queue }) => ({
        shared: 1,
        differs: queue.constructor.name,
      })),
      { name: 'AssertionError', operator: 'deepStrictEqual' },
    );
  });
});
