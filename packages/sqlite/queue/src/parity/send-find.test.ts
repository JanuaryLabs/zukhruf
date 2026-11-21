import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { outcome } from '../testing/outcome.ts';
import { Observe } from './observe.ts';
import { Parity } from './parity.ts';

describe('send and findJobs', () => {
  it('validates send arguments the way pg-boss does', async () => {
    // Wrongly typed options arrive as parsed JSON, the way an untyped caller
    // sends them; the option types cannot reject them at compile time.
    const invalid = {
      priority: '{"priority":1.5}',
      retryLimit: '{"retryLimit":-1}',
      expireInSeconds: '{"expireInSeconds":0}',
      retentionSeconds: '{"retentionSeconds":0}',
      deleteAfterSeconds: '{"deleteAfterSeconds":-1}',
      heartbeatSeconds: '{"heartbeatSeconds":5}',
      groupWithoutId: '{"group":{}}',
      groupTierType: '{"group":{"id":"g","tier":5}}',
      options: '"options"',
    };

    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      const results: Record<string, string> = {
        functionData: await outcome(() => queue.send('jobs', () => 1)),
      };
      for (const [label, options] of Object.entries(invalid)) {
        results[label] = await outcome(() =>
          queue.send('jobs', { n: 1 }, JSON.parse(options)),
        );
      }
      // Valid options the new checks must not refuse.
      results.groupWithTier = await outcome(() =>
        queue.send('jobs', { n: 1 }, { group: { id: 'g', tier: 't' } }),
      );
      results.groupWithoutTier = await outcome(() =>
        queue.send('jobs', { n: 1 }, { group: { id: 'g' } }),
      );
      results.priorityZero = await outcome(() =>
        queue.send('jobs', { n: 1 }, { priority: 0 }),
      );
      results.nullOptions = await outcome(() =>
        queue.send('jobs', { n: 1 }, JSON.parse('null')),
      );
      return results;
    });

    assert.deepStrictEqual(observed, {
      functionData:
        'AssertionError: send() cannot accept a function as the payload.  Did you intend to use work()?',
      priority: 'AssertionError: priority must be an integer',
      retryLimit: 'AssertionError: retryLimit must be an integer >= 0',
      expireInSeconds:
        'AssertionError: configuration assert: expireInSeconds must be at least every second',
      retentionSeconds:
        'AssertionError: configuration assert: retentionSeconds must be at least every second',
      deleteAfterSeconds:
        'AssertionError: configuration assert: deleteAfterSeconds must be at least 0 (0 disables deletion)',
      heartbeatSeconds:
        'AssertionError: heartbeatSeconds must be an integer >= 10',
      groupWithoutId: 'AssertionError: group.id must be a non-empty string',
      groupTierType:
        'AssertionError: group.tier must be a non-empty string if provided',
      options: 'AssertionError: options should be an object',
      groupWithTier: 'resolved',
      groupWithoutTier: 'resolved',
      priorityZero: 'resolved',
      nullOptions: 'resolved',
    });
  });

  it('filters findJobs by id, key, queued and data containment as pg-boss does', async () => {
    const uuid = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const ids = [uuid(1), uuid(2), uuid(3), uuid(4)] as const;

    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send(
        'jobs',
        { tags: ['a', 'b'], owner: { team: 'x', role: 'y' }, n: 1 },
        { id: ids[0], singletonKey: 'k1' },
      );
      await queue.send('jobs', { tags: ['b'], n: 2 }, { id: ids[1] });
      await queue.send('jobs', { tags: [], n: 3 }, { id: ids[2] });
      await queue.send('jobs', { n: 4 }, { id: ids[3] });
      await queue.cancel('jobs', ids[3] ?? '');
      // An active job is not queued.
      await queue.createQueue('running');
      await queue.send('running', { n: 5 }, { id: ids[0] });
      const claimed = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      await queue.work('running', {}, async () => {
        claimed.resolve();
        await release.promise;
      });
      await claimed.promise;
      const runningQueued = (
        await queue.findJobs('running', { queued: true })
      ).map(({ id }) => id);
      release.resolve();

      const find = async (options: object) =>
        (await queue.findJobs('jobs', options)).map(({ id }) => id).sort();
      return {
        byId: await find({ id: ids[1] }),
        byKey: await find({ key: 'k1' }),
        queued: await find({ queued: true }),
        arraySubset: await find({ data: { tags: ['b'] } }),
        arrayOrder: await find({ data: { tags: ['b', 'a'] } }),
        emptyArray: await find({ data: { tags: [] } }),
        nestedSubset: await find({ data: { owner: { team: 'x' } } }),
        scalar: await find({ data: { n: 2 } }),
        mismatch: await find({ data: { tags: ['z'] } }),
        runningQueued,
      };
    });

    const [one, two, three] = ids;
    assert.deepStrictEqual(observed, {
      byId: [two],
      byKey: [one],
      queued: [one, two, three],
      arraySubset: [one, two],
      arrayOrder: [one],
      emptyArray: [one, two, three],
      nestedSubset: [one],
      scalar: [two],
      mismatch: [],
      runningQueued: [],
    });
  });

  it('pages findJobs by limit and after in created_on then id order, after the data filter, and checks both before the queue', async () => {
    const uuid = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      // One created_on on the stopped clock, so id orders them.
      for (const n of [3, 1, 4, 2]) {
        await queue.send('jobs', { odd: n % 2 }, { id: uuid(n) });
      }
      const find = async (options: object) =>
        (await queue.findJobs('jobs', options)).map(({ id }) => id);
      const refused = (name: string, options: object) =>
        outcome(() => queue.findJobs(name, options));
      return {
        all: await find({}),
        first: await find({ limit: 2 }),
        next: await find({ limit: 2, after: uuid(2) }),
        afterLast: await find({ after: uuid(4) }),
        braced: await find({ after: `{${uuid(2).toUpperCase()}}` }),
        dataLimited: await find({ data: { odd: 1 }, limit: 1 }),
        limitZero: await refused('jobs', { limit: 0 }),
        limitFraction: await refused('jobs', { limit: 1.5 }),
        limitOver: await refused('jobs', { limit: 100_001 }),
        afterEmpty: await refused('jobs', { after: '' }),
        afterNotUuid: await refused('jobs', { after: 'x' }),
        afterGone: await refused('jobs', { after: uuid(9) }),
        limitBeforeQueue: await refused('missing', { limit: 0 }),
      };
    });

    // attorney.js:575-594, manager.js:2743-2770, plans.js:4624-4657
    // (12.38.0): limit 1 to 100000 (1000 when left out), after an id whose
    // row still exists, both checked before the queue lookup.
    const limit =
      'AssertionError: findJobs: limit must be an integer between 1 and 100000';
    assert.deepStrictEqual(observed, {
      all: [uuid(1), uuid(2), uuid(3), uuid(4)],
      first: [uuid(1), uuid(2)],
      next: [uuid(3), uuid(4)],
      afterLast: [],
      braced: [uuid(3), uuid(4)],
      dataLimited: [uuid(1)],
      limitZero: limit,
      limitFraction: limit,
      limitOver: limit,
      afterEmpty: 'AssertionError: findJobs: after must be a non-empty string',
      afterNotUuid: 'AssertionError: findJobs: after must be a uuid',
      afterGone:
        'AssertionError: findJobs: after names a row that no longer exists',
      limitBeforeQueue: limit,
    });
  });

  it('gives a found job exactly the keys of pg-boss, with no signal, even while a worker holds it', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.createQueue('running');
      await queue.send('jobs', { n: 1 });
      await queue.send('running', { n: 2 });
      const claimed = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      await queue.work('running', {}, async () => {
        claimed.resolve();
        await release.promise;
      });
      await claimed.promise;
      const keys = async (name: string) =>
        (await queue.findJobs(name)).map((job) => Object.keys(job).sort());
      try {
        return { created: await keys('jobs'), active: await keys('running') };
      } finally {
        release.resolve();
      }
    });

    // pg-boss's findJobs returns the rows as the database gives them
    // (node_modules/pg-boss/dist/manager.js:2743-2772); only a worker adds a
    // signal, to its own copy of the job (manager.js:599).
    assert.strictEqual(observed.created.length, 1);
    assert.deepStrictEqual(observed.active, observed.created);
    assert.ok(!observed.created[0]?.includes('signal'));
    assert.ok(observed.created[0]?.includes('sourceRootId'));
  });

  it('accepts the same job id in two queues', async () => {
    const job = '00000000-0000-4000-8000-000000000001';

    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('first');
      await queue.createQueue('second');
      return {
        first: await queue.send('first', { n: 1 }, { id: job }),
        second: await queue.send('second', { n: 2 }, { id: job }),
        again: await queue.send('first', { n: 3 }, { id: job }),
      };
    });

    assert.deepStrictEqual(observed, { first: job, second: job, again: null });
  });

  it('stores a sent job with exactly the row pg-boss stores', async () => {
    const job = '00000000-0000-4000-8000-000000000001';
    const deferred = '00000000-0000-4000-8000-000000000002';

    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs', { retryLimit: 3, retryDelay: 5 });
      await queue.send('jobs', { n: 1 }, { id: job, singletonKey: 'key-1' });
      // Retention counts from when a job may start, not from when it was sent.
      await queue.send('jobs', { n: 2 }, { id: deferred, startAfter: 600 });
      const [found] = await queue.findJobs('jobs', { id: job });
      const [later] = await queue.findJobs('jobs', { id: deferred });
      assert.ok(found && later, 'the sent jobs were not stored');
      const row: Record<string, unknown> = {
        ...Observe.job(found),
        deferredKeepUntil: Observe.job(later).keepUntil,
      };
      return row;
    });

    // Facts the queue defaults and the shared clock fix, so a backend pair that
    // both drop a field cannot pass on agreement alone.
    assert.ok(observed);
    assert.deepStrictEqual(
      {
        id: observed.id,
        state: observed.state,
        retryLimit: observed.retryLimit,
        retryDelay: observed.retryDelay,
        singletonKey: observed.singletonKey,
        createdOn: observed.createdOn,
        startAfter: observed.startAfter,
        keepUntil: observed.keepUntil,
        startedOn: observed.startedOn,
        output: observed.output,
        deferredKeepUntil: observed.deferredKeepUntil,
      },
      {
        id: job,
        state: 'created',
        retryLimit: 3,
        retryDelay: 5,
        singletonKey: 'key-1',
        createdOn: 0,
        startAfter: 0,
        keepUntil: 14 * 24 * 60 * 60 * 1000,
        startedOn: null,
        output: null,
        deferredKeepUntil: (600 + 14 * 24 * 60 * 60) * 1000,
      },
    );
  });
});
