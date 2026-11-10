import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-wall-clock-bound.ts';

test('no-wall-clock-bound reports a loop that stops at a time, and an assertion that an elapsed time is below a number', () => {
  typescriptRuleTester().run('no-wall-clock-bound', rule, {
    valid: [
      // Wait for the fact.
      {
        code: `await t.waitFor(async () => assert.equal(await held(), false), { interval: 5, timeout: 10_000 });`,
      },
      // A lower bound stays true under load.
      {
        code: `const started = performance.now(); await work(); const elapsed = performance.now() - started; assert.ok(elapsed >= 4_500);`,
      },
      {
        code: `const started = Date.now(); await work(); assert.ok(1000 <= Date.now() - started);`,
      },
      // A time on a fake clock is exact.
      {
        code: `const started = clock.performance.now(); await clock.tickAsync(10); assert.ok(clock.performance.now() - started < 20);`,
      },
      // The order of two reads is not a limit (packages/mutex file-lock-store).
      {
        code: `const releasedAt = Date.now(); const closedAt = await close(); assert.ok(releasedAt < closedAt);`,
      },
      // A comparison that is not about time.
      { code: `assert.ok(tries < 3);` },
      { code: `const size = rows.length; assert.ok(size <= 10);` },
      { code: `while (tries < 3) tries++;` },
      // An assertion that says the opposite of true is not an upper bound.
      {
        code: `const waited = Date.now() - started; assert.equal(waited < 10, false);`,
      },
      // A read outside the condition does not make the loop stop at a time.
      {
        code: `while (!done()) { const now = performance.now(); log(now); await step(); }`,
      },
      // A const read once does not move, so the loop does not stop at a time.
      {
        code: `const limit = Date.now() + 10; while (!done(limit)) await step();`,
      },
    ],
    invalid: [
      {
        // packages/mutex is-held, the flake of #3476.
        code: `let afterKill = true; const releasedBy = performance.now() + 20; while (afterKill && performance.now() < releasedBy) { afterKill = await mutex.isHeld('k'); }`,
        errors: [{ messageId: 'loop' }],
      },
      {
        code: `do { await step(); } while (Date.now() - started < 5000);`,
        errors: [{ messageId: 'loop' }],
      },
      {
        code: `for (const end = Date.now() + 100; end > Date.now(); ) await step();`,
        errors: [{ messageId: 'loop' }],
      },
      {
        // packages/coprocess: 'kill stops a process that exits on SIGTERM'.
        code: `const started = performance.now(); await stop(); assert.ok(performance.now() - started < 2_000);`,
        errors: [{ messageId: 'assertion' }],
      },
      {
        // packages/coprocess: the lower bound stays, the upper bound is reported.
        code: `const started = performance.now(); await stop(); const elapsed = performance.now() - started; assert.ok(elapsed >= 4_500 && elapsed < 8_000, 'took');`,
        errors: [{ messageId: 'assertion' }],
      },
      {
        // packages/single-flight failover.
        code: `const termSeen = performance.now(); await heard(); const waited = performance.now() - termSeen; assert.ok(waited < 400);`,
        errors: [{ messageId: 'assertion' }],
      },
      {
        // packages/testing teardown: another unit, and a read from a variable.
        code: `const endedAt = Date.now(); const seconds = (endedAt - mtimeMs) / 1000; assert.ok(seconds >= 250 && seconds <= 250 + 60);`,
        errors: [{ messageId: 'assertion' }],
      },
      {
        // packages/fs file-lock: a read assigned later.
        code: `let elapsed; const s = performance.now(); run(); elapsed = performance.now() - s; assert.ok(elapsed < 40);`,
        errors: [{ messageId: 'assertion' }],
      },
      {
        code: `const waited = Date.now() - started; assert.equal(waited < 10, true);`,
        errors: [{ messageId: 'assertion' }],
      },
      {
        code: `const waited = Date.now() - started; assert.strictEqual(waited <= 10, true);`,
        errors: [{ messageId: 'assertion' }],
      },
      {
        code: `const waited = Date.now() - started; t.assert.ok(waited < 10);`,
        errors: [{ messageId: 'assertion' }],
      },
      {
        code: `const waited = Date.now() - started; assert(waited < 10);`,
        errors: [{ messageId: 'assertion' }],
      },
      {
        code: `const waited = Date.now() - started; assert.ok(10 > waited);`,
        errors: [{ messageId: 'assertion' }],
      },
    ],
  });
});
