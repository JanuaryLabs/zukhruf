import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import {
  typedRuleTester,
  typescriptRuleTester,
} from '../testing/rule-tester.ts';
import rule from './no-own-wait-limit.ts';

test('no-own-wait-limit reports a wait in a test that sets its own time limit', () => {
  typescriptRuleTester().run('no-own-wait-limit', rule, {
    valid: [
      // The wait ends at the limit of the test.
      {
        code: `test('x', async (t) => { await waitFor(() => assert.ok(ready()), { signal: t.signal }); });`,
      },
      { code: `await untilAborted(exited, t.signal);` },
      { code: `const signal = AbortSignal.any([t.signal, stop.signal]);` },
      // A waitFor that is not on a test context.
      { code: `await vi.waitFor(() => assert.ok(ready()));` },
      { code: `await page.locator('#x').waitFor();` },
      {
        code: `items.forEach((item) => item.waitFor({ timeout: 10 }));`,
      },
      // A time limit that the test moves on a clock of its own.
      { code: `using limit = timeout(50, { clock });` },
      // The abort is the subject of the test: it reads the reason.
      {
        code: `const signal = AbortSignal.timeout(10); await assert.rejects(untilAborted(never, signal), (error) => error === signal.reason);`,
      },
      {
        code: `const signal = AbortSignal.timeout(300); const outcome = await settle(run({ signal })); assert.deepEqual(outcome, { error: signal.reason });`,
      },
    ],
    invalid: [
      ...[
        `test('x', async (t) => { await t.waitFor(() => assert.ok(ready()), { interval: 10, timeout: 1000 }); });`,
        `it('x', async (context) => { await context.waitFor(check); });`,
        `test('x', async (t) => { await t.test('y', async (st) => { await st.waitFor(check); }); });`,
        `describe('x', () => { test('y', async function (t) { await t.waitFor(check); }); });`,
        `async function until(t: TestContext) { await t.waitFor(check); }`,
        `const until = async (t: test.TestContext) => t.waitFor(check);`,
      ].map((code) => ({ code, errors: [{ messageId: 'waitFor' }] })),
      ...[
        `await settleWithin(exited, 'the child exits', 10_000);`,
        `await settleWithin(exited, 'the child exits', limit);`,
        // The default limit of settleWithin is a number of its own too.
        `await settleWithin(exited, 'the child exits');`,
      ].map((code) => ({ code, errors: [{ messageId: 'settleWithin' }] })),
      ...[
        `await store.acquire('a', { signal: AbortSignal.timeout(10_000) });`,
        `await pool.use(job, AbortSignal.timeout(limit));`,
        `const signal = AbortSignal.any([t.signal, AbortSignal.timeout(5000)]);`,
        `async function scenario(signal = AbortSignal.timeout(30_000)) {}`,
        `const limit = AbortSignal.timeout(10_000); await once(limit, 'abort');`,
        // A reason read from another signal does not make this one the subject.
        `const limit = AbortSignal.timeout(10_000); assert.equal(error, other.reason);`,
      ].map((code) => ({ code, errors: [{ messageId: 'signalTimeout' }] })),
    ],
  });
});

test('no-own-wait-limit reads the type of a test context that an interface types', async () => {
  await using workspace = await fixtureWorkspace({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'esnext',
        lib: ['esnext', 'dom'],
        types: [],
      },
      include: ['index.ts'],
    }),
    'index.ts': 'export {};\n',
  });
  const filename = workspace.path('subject.ts');
  const declarations = [
    'interface TestContext { signal: AbortSignal; waitFor(check: () => void): Promise<void>; }',
    'interface Locator { waitFor(): Promise<void>; }',
    'interface Subject { untilReady(t: TestContext): Promise<void>; untilShown(locator: Locator): Promise<void>; }',
  ].join('\n');

  typedRuleTester(workspace.root).run('no-own-wait-limit', rule, {
    valid: [
      {
        filename,
        code: `${declarations}\nconst subject: Subject = { async untilReady() {}, async untilShown(locator) { await locator.waitFor(); } };`,
      },
    ],
    invalid: [
      {
        filename,
        code: `${declarations}\nconst subject: Subject = { async untilReady(t) { await t.waitFor(() => {}); }, async untilShown() {} };`,
        errors: [{ messageId: 'waitFor' }],
      },
    ],
  });
});
