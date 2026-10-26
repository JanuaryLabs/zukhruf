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
