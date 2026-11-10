import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-timer-race.ts';

test('no-timer-race reports a race against a timer that rejects or throws', () => {
  typescriptRuleTester().run('no-timer-race', rule, {
    valid: [
      // A timer that resolves a marker asserts that the promise stays pending.
      { code: `await Promise.race([work, sleep(1200).then(() => false)]);` },
      { code: `await Promise.race([work, delay(ms, 'pending')]);` },
      {
        code: `await Promise.race([work, new Promise((r) => setImmediate(r, 'pending'))]);`,
      },
      {
        code: `await Promise.race([work, new Promise((resolve) => setTimeout(resolve, ms))]);`,
      },
      {
        code: `await Promise.race([work, new Promise((resolve, reject) => { setTimeout(resolve, ms); signal.onabort = reject; })]);`,
      },
      { code: `await Promise.race([work, setTimeout(ms, 'late')]);` },
      {
        code: `const late = sleep(ms).then(() => 'late');\nawait Promise.race([work, late]);`,
      },
      {
        code: `const { promise, resolve, reject } = Promise.withResolvers();\nsetTimeout(() => resolve('late'), ms);\nsource.on('error', reject);\nawait Promise.race([work, promise]);`,
      },
      {
        code: `await Promise.race([work, sleep(ms).then(() => { done = true; })]);`,
      },
      // A rejection that is not a timer's.
      {
        code: `await Promise.race([work, health().then(() => { throw new Error('down'); })]);`,
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
      // The result is not compared.
      { code: `const now = await Promise.race([work, delay(ms, 'waiting')]);` },
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
    ].map((code) => ({ code, errors: [{ messageId: 'deadline' }] })),
  });
});
