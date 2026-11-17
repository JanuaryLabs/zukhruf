import assert from 'node:assert/strict';
import { test } from 'node:test';

import { waitFor } from './index.ts';

const timers = () =>
  process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout')
    .length;

test('waitFor rejects with the reason of the signal and the last failure of the check as its cause', async () => {
  // Arrange: the limit aborts after the third failed check.
  const limit = new AbortController();
  const before = timers();
  let calls = 0;
  const check = () => {
    calls += 1;
    if (calls === 3) setImmediate(() => limit.abort());
    throw new Error(`check ${calls} failed`);
  };

  // Act
  const waited = await waitFor(check, {
    signal: limit.signal,
    interval: 5,
  }).catch((error: unknown) => error);

  // Assert
  assert.equal(waited, limit.signal.reason);
  assert.ok(Error.isError(waited));
  assert.deepEqual(waited.cause, new Error('check 3 failed'));
  assert.equal(calls, 3);
  assert.equal(timers(), before, 'The aborted wait must stop its timer.');
});

test('waitFor resolves with the value of the first check that passes', async () => {
  // Arrange: the check fails twice, then passes.
  const limit = new AbortController();
  const before = timers();
  let calls = 0;
  const check = async () => {
    calls += 1;
    if (calls < 3) throw new Error(`check ${calls} failed`);
    return `passed on check ${calls}`;
  };

  // Act
  const value = await waitFor(check, { signal: limit.signal, interval: 5 });

  // Assert
  assert.equal(value, 'passed on check 3');
  assert.equal(timers(), before, 'A wait that passed must leave no timer.');
});

test('waitFor rejects when the signal aborts during a check that never settles', async () => {
  // Arrange: the check never settles, and the limit aborts while it runs.
  const limit = new AbortController();
  const started = Promise.withResolvers<void>();
  const check = () => {
    started.resolve();
    return new Promise<never>(() => {});
  };

  // Act
  const waited = waitFor(check, { signal: limit.signal });
  await started.promise;
  limit.abort();

  // Assert
  await assert.rejects(waited, (error) => error === limit.signal.reason);
});
