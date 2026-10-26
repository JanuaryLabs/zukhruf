import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-sleep-poll-loop.ts';

test('no-sleep-poll-loop reports a loop that sleeps between checks', () => {
  typescriptRuleTester().run('no-sleep-poll-loop', rule, {
    valid: [
      {
        code: `await t.waitFor(() => assert.ok(ready()), { interval: 10, timeout: 1000 });`,
      },
      // A fixed pause outside a loop is a window, not a poll.
      { code: `await delay(5000);` },
      // A loop that awaits work, not a timer.
      { code: `while (!done) await step();` },
      { code: `for (;;) { if (await poll()) break; await setImmediate(); }` },
      { code: `for await (const line of lines) await delay(10);` },
      // The timer runs in a callback that the loop builds, not between checks.
      {
        code: `while (jobs.length > 0) queue.push(async () => { await sleep(10); run(jobs.pop()); });`,
      },
      // A promise that resolves on an event, not on a timer.
      {
        code: `while (!ready) await new Promise((r) => emitter.once('x', r));`,
      },
    ],
    invalid: [
      `while (!ready()) await setTimeout(10);`,
      `while (!ready()) await timers.setTimeout(10);`,
      `while (!ready()) await new Promise((resolve) => setTimeout(resolve, 5));`,
      `while (!ready()) { await new Promise((resolve) => { setTimeout(resolve, 5); }); }`,
      `do { await sleep(10); } while (!ready());`,
      `for (let i = 0; i < 10 && !ready(); i++) await delay(50);`,
      `for (;;) { if (await ready()) return; await delay(10); }`,
      `while (!a()) { if (b()) { await delay(10); } else { await sleep(20); } }`,
      `async function until() { while (!ready()) await delay(10); }`,
    ].map((code) => ({ code, errors: [{ messageId: 'matched' }] })),
  });
});
