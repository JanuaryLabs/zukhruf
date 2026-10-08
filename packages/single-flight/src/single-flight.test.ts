import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SingleFlight } from './index.ts';

test(
  'a call after a flight ended runs the work again, also after a flight that failed',
  { timeout: 10_000 },
  async () => {
    const flights = new SingleFlight<string>();
    const failure = new Error('disk full');

    const failed = flights.run('report:daily', async () => {
      throw failure;
    });
    await assert.rejects(failed, (error) => error === failure);
    const second = await flights.run(
      'report:daily',
      async () => 'second build',
    );
    const third = await flights.run('report:daily', async () => 'third build');

    assert.deepEqual(second, { value: 'second build', joined: false });
    assert.deepEqual(third, { value: 'third build', joined: false });
  },
);

test(
  'three callers of one key at the same time share one execution',
  { timeout: 10_000 },
  async () => {
    const flights = new SingleFlight<string>();
    const built = Promise.withResolvers<void>();
    let executions = 0;
    let joins = 0;
    const build = async () => {
      executions++;
      await built.promise;
      return `report ${executions}`;
    };
    const onJoin = () => joins++;

    const calls = [1, 2, 3].map(() =>
      flights.run('report:daily', build, { onJoin }),
    );
    built.resolve();
    const results = await Promise.all(calls);

    assert.equal(executions, 1);
    assert.equal(joins, 2);
    assert.deepEqual(results, [
      { value: 'report 1', joined: false },
      { value: 'report 1', joined: true },
      { value: 'report 1', joined: true },
    ]);
  },
);

test(
  'when every caller cancels, the work is told and the flight is forgotten: the next call runs a new flight',
  { timeout: 10_000 },
  async () => {
    const flights = new SingleFlight<string>();
    const signals: AbortSignal[] = [];
    const built = Promise.withResolvers<void>();
    // This work does not stop when it is told, so the abandoned flight stays in progress.
    const build = async (abandoned: AbortSignal) => {
      const flight = signals.push(abandoned);
      await built.promise;
      return `report ${flight}`;
    };
    const [first, second] = [new AbortController(), new AbortController()];
    try {
      const calls = [first, second].map(({ signal }) =>
        flights.run('report:daily', build, { signal }),
      );

      first.abort();
      await assert.rejects(calls[0]!);
      const abandonedAfterOne = signals[0]!.aborted;
      second.abort();
      await assert.rejects(calls[1]!);
      const next = flights.run('report:daily', build);
      built.resolve();

      assert.equal(abandonedAfterOne, false);
      assert.equal(signals[0]!.aborted, true);
      assert.deepEqual(await next, { value: 'report 2', joined: false });
    } finally {
      built.resolve();
    }
  },
);
