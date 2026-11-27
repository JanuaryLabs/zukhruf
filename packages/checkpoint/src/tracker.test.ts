import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CappedTracker, UncappedTracker } from './index.ts';

test('the highest position is undefined until a batch is done', () => {
  const tracker = new UncappedTracker<number>();

  tracker.track(10, 1);

  assert.equal(tracker.highest(), undefined);
});

test('a batch that ends before an earlier one does not pass it, and the end of the earlier one moves the highest position past both', () => {
  const tracker = new UncappedTracker<number>();
  const first = tracker.track(10, 1);
  const second = tracker.track(20, 1);
  const third = tracker.track(30, 1);

  assert.equal(second(), undefined);
  assert.equal(tracker.highest(), undefined);
  assert.equal(first(), 20);
  assert.equal(tracker.highest(), 20);
  assert.equal(third(), 30);
});

test('pending is the size of the batches that are not done, and a second end of a batch counts once', () => {
  const tracker = new UncappedTracker<number>();
  const first = tracker.track(10, 3);
  tracker.track(20, 4);

  first();
  first();

  assert.equal(tracker.pending, 4);
  assert.equal(tracker.highest(), 10);
});

test('a capped track waits while the open batches leave no room, and goes on when a batch ends', async () => {
  const tracker = new CappedTracker<number>(5);
  const first = await tracker.track(10, 4);

  const waiting = tracker.track(20, 2);

  assert.equal(tracker.pending, 4);
  assert.equal(first(), 10);
  const second = await waiting;
  assert.equal(tracker.pending, 2);
  assert.equal(second(), 20);
});

test('a capped track of a batch larger than the capacity waits until no batch is open', async () => {
  const tracker = new CappedTracker<number>(2);
  const first = await tracker.track(10, 1);

  const large = tracker.track(20, 5);

  assert.equal(tracker.pending, 1);
  first();
  const done = await large;
  assert.equal(tracker.pending, 5);
  assert.equal(done(), 20);
});

test('an aborted signal rejects a waiting capped track with its reason and adds no batch', async () => {
  const tracker = new CappedTracker<number>(1);
  const first = await tracker.track(10, 1);
  const controller = new AbortController();
  const reason = new Error('stopped');

  const waiting = tracker.track(20, 1, { signal: controller.signal });
  controller.abort(reason);

  await assert.rejects(waiting, (error) => {
    assert.equal(error, reason);
    return true;
  });
  assert.equal(tracker.pending, 1);
  assert.equal(first(), 10);
  assert.equal(tracker.pending, 0);
});

test('a batch that ends while an earlier one is open gives back the highest position so far', () => {
  const tracker = new UncappedTracker<number>();
  const first = tracker.track(10, 1);
  const second = tracker.track(20, 1);
  const third = tracker.track(30, 1);

  first();

  assert.equal(third(), 10);
  assert.equal(second(), 30);
});

test('a capped track that fills the capacity exactly goes on at once, and one more waits', async () => {
  const tracker = new CappedTracker<number>(5);
  const first = await tracker.track(10, 4);
  await tracker.track(20, 1);

  const waiting = tracker.track(30, 1);

  assert.equal(tracker.pending, 5);
  first();
  await waiting;
  assert.equal(tracker.pending, 2);
});

test('a capped track with a signal that already aborted rejects with its reason and adds no batch', async () => {
  const tracker = new CappedTracker<number>(5);
  const reason = new Error('stopped');

  await assert.rejects(
    tracker.track(10, 1, { signal: AbortSignal.abort(reason) }),
    (error) => {
      assert.equal(error, reason);
      return true;
    },
  );
  assert.equal(tracker.pending, 0);
});
