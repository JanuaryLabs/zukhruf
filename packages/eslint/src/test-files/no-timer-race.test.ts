import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import {
  typedRuleTester,
  typescriptRuleTester,
} from '../testing/rule-tester.ts';
import rule from './no-timer-race.ts';

test('no-timer-race reports a race against a timer that rejects or throws', () => {
  typescriptRuleTester().run('no-timer-race', rule, {
    valid: [
      // The wait ends at the test's limit.
      { code: `await untilAborted(work, t.signal);` },
      // A timer that resolves a marker, and an assertion that the promise stays pending.
      {
        code: `assert.equal(await Promise.race([work, sleep(1200).then(() => false)]), false);`,
      },
      {
        code: `assert.equal(await Promise.race([work, setTimeout(ms, 'late')]), 'late');`,
      },
      {
        code: `const late = sleep(ms).then(() => 'late');\nassert.equal(await Promise.race([work, late]), 'late');`,
      },
      {
        code: `const { promise, resolve, reject } = Promise.withResolvers();\nsetTimeout(() => resolve('late'), ms);\nsource.on('error', reject);\nassert.equal(await Promise.race([work, promise]), 'late');`,
      },
      // A rejection that is not a timer's.
      {
        code: `await Promise.race([work, health().then(() => { throw new Error('down'); })]);`,
      },
      {
        code: `await Promise.race([work, new Promise((r) => setImmediate(r, 'pending'))]);`,
      },
      { code: `await Promise.race([work, aborted(signal)]);` },
      { code: `await Promise.race([first, second]);` },
    ],
    invalid: [
      `await Promise.race([work, new Promise((_, reject) => setTimeout(() => reject(new Error('late')), ms))]);`,
      `await Promise.race([work, new Promise((_, reject) => setTimeout(reject, ms))]);`,
      `await Promise.race([work, new Promise(function (_, fail) { setTimeout(() => fail(new Error('late')), ms); })]);`,
      `await Promise.race([work, sleep(ms).then(() => { throw new Error('late'); })]);`,
      `await Promise.race([work, delay(ms).then(() => { throw new Error('late'); })]);`,
      `await Promise.race([work, setTimeout(ms).then(() => { throw new Error('late'); })]);`,
      `await Promise.race([work, timers.setTimeout(ms).then(() => { throw new Error('late'); })]);`,
      `const timeout = new Promise((_, reject) => setTimeout(reject, ms));\nawait Promise.race([work, timeout]);`,
      `const { promise: timeout, reject } = Promise.withResolvers();\nconst timer = setTimeout(() => reject(new Error('late')), ms);\nawait Promise.race([work, timeout]);`,
      // assert.fail throws as `throw` does.
      `await Promise.race([work, delay(ms).then(() => assert.fail('late'))]);`,
      `await Promise.race([work, delay(ms).then(() => { assert.fail('late'); })]);`,
    ].map((code) => ({ code, errors: [{ messageId: 'matched' }] })),
  });
});

test('no-timer-race reports a marker race whose result must not be the marker, which is a deadline in disguise', () => {
  typescriptRuleTester().run('no-timer-race', rule, {
    valid: [
      // The promise stays pending: load only makes this more true.
      {
        code: `assert.equal(await Promise.race([work, delay(ms, 'waiting')]), 'waiting');`,
      },
      {
        code: `const now = await Promise.race([work, delay(ms, 'still waiting' as const, { ref: false })]);\nassert.equal(now, 'still waiting');`,
      },
      {
        code: `const timer = delay(ms, 'waiting');\nconst now = await Promise.race([work, timer]);\nassert.strictEqual(now, 'waiting');`,
      },
      {
        code: `assert.notEqual(await Promise.race([work, delay(ms, 'waiting')]), 'done');`,
      },
      // No timer in the race.
      { code: `assert.equal(await Promise.race([first, second]), 'first');` },
    ],
    invalid: [
      // packages/mutex postgres-store, the 300 ms race of #3476.
      `const next = await Promise.race([running, delay(300, 'still waiting')]);\nassert.equal(next, 'ran');`,
      `assert.equal(await Promise.race([running, delay(300, 'still waiting')]), 'ran');`,
      // packages/mutex socket-store: the deadline is a variable.
      `const deadline = delay(2000, 'timed out' as const, { ref: false });\nconst shutdown = await Promise.race([closing, deadline]);\nassert.equal(shutdown, 'closed');`,
      // packages/mutex ticket-queue-file-store: not the marker.
      `const outcome = await Promise.race([waiter, delay(2000, 'still waiting')]);\nassert.notEqual(outcome, 'still waiting');`,
      // packages/mutex process contract: the result is a value of the promise, and the marker is null.
      `const acquired = await Promise.race([acquire(), delay(limit, null, { ref: false })]);\nassert.equal(acquired, true);`,
      `const done = await Promise.race([work, sleep(ms).then(() => false)]);\nassert.equal(done, true);`,
      `assert.deepEqual(await Promise.race([work, setTimeout(ms)]), { ok: true });`,
      // A truthy result, when the marker is false.
      `assert.ok(await Promise.race([work, sleep(ms).then(() => false)]));`,
      // A failure when the result is the marker.
      `if ((await Promise.race([work, delay(ms, 'waiting')])) === 'waiting') assert.fail('late');`,
    ].map((code) => ({ code, errors: [{ messageId: 'deadline' }] })),
  });
});

test('no-timer-race allows a marker race only when each read of its result asserts that the result is the marker', () => {
  const outcomeOf = `const outcomeOf = (promise, within) =>\n  Promise.race([\n    promise.then((value) => ({ settled: 'resolved' as const, value })),\n    delay(within, { settled: 'pending' as const }),\n  ]);`;
  typescriptRuleTester().run('no-timer-race', rule, {
    valid: [
      // The marker, in each form of the assertion.
      {
        code: `assert.strictEqual('waiting', await Promise.race([work, delay(ms, 'waiting')]));`,
      },
      {
        code: `assert.ok(await Promise.race([work, sleep(ms).then(() => true)]));`,
      },
      {
        code: `assert.ok((await Promise.race([work, delay(ms, 'waiting')])) === 'waiting');`,
      },
      {
        code: `const now = await Promise.race([work, delay(ms, 'waiting')]);\nif (now !== 'waiting') assert.fail('The work must stay pending');`,
      },
      {
        code: `const now = await Promise.race([work, delay(ms, 'waiting')]);\nif (now !== 'waiting') { throw new Error('The work must stay pending'); }`,
      },
      // A read that only builds the report of the failure: context-compiler plugin.e2e.test.ts.
      {
        code: `const early = await Promise.race([replaced, sleep(frozenFor).then(() => 'waiting')]);\nif (early !== 'waiting') assert.fail(\`The sync returned while the pass was frozen: \${JSON.stringify(photosRow(early))}\`);`,
      },
      {
        code: `const now = await Promise.race([work, delay(ms, 'waiting')]);\nassert.equal(now, 'waiting', \`The work ended with \${String(now)}\`);`,
      },
      // A member of an object marker, and the whole marker with its nested `as const`.
      {
        code: `${outcomeOf}\nconst whileHeld = await outcomeOf(waiting, 500);\nassert.deepEqual(whileHeld, { settled: 'pending' });`,
      },
      {
        code: `${outcomeOf}\nconst whileHeld = await outcomeOf(waiting, 500);\nassert.equal(whileHeld.settled, 'pending');`,
      },
      {
        code: `${outcomeOf}\nconst { settled } = await outcomeOf(waiting, 500);\nassert.equal(settled, 'pending');`,
      },
      // A helper that a function declares, which returns the race from a try.
      {
        code: `async function pendingAfter(promise, ms) {\n  const stop = new AbortController();\n  try {\n    return await Promise.race([promise, delay(ms, 'pending', { signal: stop.signal })]);\n  } finally {\n    stop.abort();\n  }\n}\nassert.equal(await pendingAfter(work, 100), 'pending');`,
      },
    ],
    invalid: [
      // No read: the race ends the wait, and nothing asserts which side won.
      {
        code: `await Promise.race([work, sleep(ms).then(() => false)]);`,
        errors: [{ messageId: 'ownLimit', line: 1, column: 7 }],
      },
      `const now = await Promise.race([work, delay(ms, 'waiting')]);`,
      `await Promise.race([work, new Promise((resolve) => setTimeout(resolve, ms))]);`,
      `await Promise.race([work, new Promise((resolve, reject) => { setTimeout(resolve, ms); signal.onabort = reject; })]);`,
      `await Promise.race([work, sleep(ms).then(() => { done = true; })]);`,
      // A timer that resolves the promise of Promise.withResolvers; a reject that another source calls does not change that.
      `const { promise, resolve, reject } = Promise.withResolvers();\nsetTimeout(() => resolve('late'), ms);\nsource.on('error', reject);\nawait Promise.race([work, promise]);`,
      `const { promise, resolve } = Promise.withResolvers();\nsetTimeout(resolve, ms, 'late');\nawait Promise.race([work, promise]);`,
      // packages/sqlite/queue batch: the result goes into data that the test compares.
      `async function run() {\n  const stopped = await Promise.race([queue.offWork('jobs').then(() => 'stopped'), new Promise((resolve) => setTimeout(() => resolve('stuck'), 5000))]);\n  return { stopped };\n}`,
      // packages/sqlite/queue error-events: a timer whose abort a catch handles.
      `async function run() {\n  const ran = await Promise.race([handled.promise, sleep(5000, null, { signal }).catch(() => null)]);\n  return { failedPoll: failedPoll !== null, ran };\n}`,
      // A read that is not an assertion of the marker.
      `const now = await Promise.race([work, delay(ms, 'waiting')]);\nassert.ok(now);`,
      `const now = await Promise.race([work, delay(ms, 'waiting')]);\nassert.match(now, /done/);`,
      `const now = await Promise.race([work, delay(ms, 'waiting')]);\nconsole.log(now);`,
      `const now = await Promise.race([work, delay(ms, 'waiting')]);\nif (now !== 'waiting') console.log(now);`,
      `while ((await Promise.race([work, delay(ms, 'waiting')])) === 'waiting') await tick();`,
      // packages/mutex docker-engine-store: a value of the promise, which the marker does not have.
      {
        code: `${outcomeOf}\nconst outcome = await outcomeOf(waiting, engineBound);\nassert.ok(outcome.value > holder.token);`,
        errors: [{ messageId: 'ownLimit', line: 6 }],
      },
      // The call of a helper with no read, reported where the helper is called.
      {
        code: `${outcomeOf}\nawait outcomeOf(stale, engineBound);`,
        errors: [{ messageId: 'ownLimit', line: 6, column: 7 }],
      },
      // A helper that calls a helper.
      `${outcomeOf}\nconst settledWithin = (promise) => outcomeOf(promise, 100);\nawait settledWithin(stale);`,
    ].map((item) =>
      typeof item === 'string'
        ? { code: item, errors: [{ messageId: 'ownLimit' }] }
        : item,
    ),
  });
});

test('no-timer-race follows a chain of up to four helpers in the linted file', () => {
  const chain = (length: number) =>
    [
      `const h1 = (promise) => Promise.race([promise, delay(100, 'pending')]);`,
      ...Array.from(
        { length: length - 1 },
        (_, index) =>
          `const h${index + 2} = (promise) => h${index + 1}(promise);`,
      ),
      `await h${length}(stale);`,
    ].join('\n');
  typescriptRuleTester().run('no-timer-race', rule, {
    valid: [{ code: chain(5) }],
    invalid: [3, 4].map((length) => ({
      code: chain(length),
      errors: [{ messageId: 'ownLimit', line: length + 1 }],
    })),
  });
});

test('no-timer-race reports a deadline and a read of another value in one race', () => {
  typescriptRuleTester().run('no-timer-race', rule, {
    valid: [],
    invalid: [
      {
        // packages/mutex docker-engine-store, the window of #5483.
        code: `const outcomeOf = (promise, within) =>\n  Promise.race([\n    promise.then((value) => ({ settled: 'resolved' as const, value })),\n    delay(within, { settled: 'pending' as const }),\n  ]);\nconst outcome = await outcomeOf(waiting, heartbeatInterval + engineBound);\nassert.equal(outcome.settled, 'resolved');\nassert.ok(outcome.value >= heartbeatInterval);`,
        errors: [
          { messageId: 'ownLimit', line: 6 },
          { messageId: 'deadline', line: 7 },
        ],
      },
    ],
  });
});

test('no-timer-race follows a helper of another file through the type checker', async () => {
  await using fixture = await fixtureWorkspace({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'esnext',
        module: 'nodenext',
        lib: ['esnext'],
        allowImportingTsExtensions: true,
        types: [],
      },
      include: ['*.ts', '*.mts'],
    }),
    // The shape of packages/mutex/src/testing/granted-within.ts.
    'helpers.ts': [
      `declare function delay<T>(ms: number, value: T, options?: { ref?: boolean }): Promise<T>;`,
      `export function grantedWithin(lease: Promise<unknown>, milliseconds: number) {`,
      `  return Promise.race([`,
      `    lease.then(() => 'granted' as const),`,
      `    delay(milliseconds, 'waiting' as const, { ref: false }),`,
      `  ]);`,
      `}`,
      `export const grantedSoon = (lease: Promise<unknown>) => grantedWithin(lease, 10);`,
      // A chain of three, four and five helpers: the rule follows four.
      `export const grantedSoon3 = (lease: Promise<unknown>) => grantedSoon(lease);`,
      `export const grantedSoon4 = (lease: Promise<unknown>) => grantedSoon3(lease);`,
      `export const grantedSoon5 = (lease: Promise<unknown>) => grantedSoon4(lease);`,
    ].join('\n'),
    // On disk, so the tsconfig holds the case, as no-unhandled-readline-error.test.ts explains.
    'case.mts': 'export {};\n',
  });
  const filename = fixture.path('case.mts');
  const header = `import { grantedWithin, grantedSoon, grantedSoon3, grantedSoon4, grantedSoon5 } from './helpers.ts';\ndeclare const acquiring: Promise<number>;\n`;

  typedRuleTester(fixture.root).run('no-timer-race', rule, {
    valid: [
      {
        filename,
        code: `${header}assert.equal(await grantedWithin(acquiring, 10), 'waiting');`,
      },
      {
        filename,
        code: `${header}const whileFrozen = await grantedSoon(acquiring);\nassert.equal(whileFrozen, 'waiting');`,
      },
      {
        filename,
        code: `${header}await grantedSoon5(acquiring);`,
      },
    ],
    invalid: [
      // packages/mutex socket-store-coordinator.test.ts:217 and socket-store.test.ts:1057.
      {
        filename,
        code: `${header}assert.equal(await grantedWithin(acquiring, 10), 'granted', 'Other keys must not wait');`,
        errors: [{ messageId: 'deadline' }],
      },
      // packages/mutex socket-store.test.ts:1043.
      {
        filename,
        code: `${header}while ((await grantedWithin(acquiring, 10)) === 'waiting') await tick();`,
        errors: [{ messageId: 'ownLimit', line: 3, column: 15 }],
      },
      {
        filename,
        code: `${header}await grantedSoon(acquiring);`,
        errors: [{ messageId: 'ownLimit' }],
      },
      {
        filename,
        code: `${header}await grantedSoon3(acquiring);`,
        errors: [{ messageId: 'ownLimit' }],
      },
      {
        filename,
        code: `${header}await grantedSoon4(acquiring);`,
        errors: [{ messageId: 'ownLimit' }],
      },
    ],
  });
});
