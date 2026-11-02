import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { typescriptRuleTester } from '../testing/rule-tester.ts';
import plugin from './plugin.ts';

const workspaceFiles = {
  'nx.json': '{}',
  'packages/island/project.json': JSON.stringify({ tags: ['layer:island'] }),
  'packages/island/src/index.ts': '',
  'packages/library/project.json': JSON.stringify({ tags: [] }),
  'packages/library/src/index.ts': '',
  'apps/host/project.json': JSON.stringify({ tags: ['scope:app'] }),
  'apps/host/src/main.ts': '',
};

test('island/no-ambient-time reports a read of the time or a timer that no clock gives, in islands and library globs, not in hosts', async () => {
  await using workspace = await fixtureWorkspace(workspaceFiles);
  const island = workspace.path('packages/island/src/index.ts');
  const libraries = { island: { libraries: ['packages/library/**/*.ts'] } };
  const ambient = (code: string, read: string) => ({
    code,
    filename: island,
    errors: [{ messageId: 'ambient', data: { read } }],
  });
  const timers = (code: string, name: string, module: string) => ({
    code,
    filename: island,
    errors: [{ messageId: 'timers', data: { name, module } }],
  });

  typescriptRuleTester().run(
    'no-ambient-time',
    plugin.rules['no-ambient-time'],
    {
      valid: [
        // A host reads its own time.
        {
          code: `setTimeout(() => {}, 10); const now = Date.now();`,
          filename: workspace.path('apps/host/src/main.ts'),
          settings: libraries,
        },
        // The clock that the caller gives.
        {
          code: `export function wait(clock: { setTimeout(f: () => void, ms: number): unknown; performance: { now(): number } }) { clock.setTimeout(() => {}, 10); return clock.performance.now(); }`,
          filename: island,
        },
        {
          code: `export function stamp(clock: { Date: DateConstructor }) { return [clock.Date.now(), new clock.Date()]; }`,
          filename: island,
        },
        // Real time on purpose: globalThis given as the clock.
        {
          code: `declare function delay(ms: number, options: { clock: unknown }): Promise<void>; await delay(10, { clock: globalThis });`,
          filename: island,
        },
        // A turn of the event loop, a conversion, and a parse are not a read of the time.
        { code: `setImmediate(() => {});`, filename: island },
        {
          code: `import { setImmediate } from 'node:timers/promises'; await setImmediate();`,
          filename: island,
        },
        {
          code: `export const epoch = new Date(0); export const when = (value: string) => new Date(value); export const parsed = Date.parse('2026-11-02');`,
          filename: island,
        },
        {
          code: `import { monitorEventLoopDelay } from 'node:perf_hooks'; export const histogram = monitorEventLoopDelay();`,
          filename: island,
        },
        // A local binding with the name of a global.
        {
          code: `const setTimeout = (f: () => void) => f(); setTimeout(() => {});`,
          filename: island,
        },
        {
          code: `export const read = (Date: { now(): number }) => Date.now();`,
          filename: island,
        },
        // In a script, a top-level var binds the global scope, and still shadows.
        {
          code: `var setTimeout = function (f) { f(); }; setTimeout(function () {});`,
          filename: island,
          languageOptions: { sourceType: 'script' },
        },
        // A type position reads nothing.
        {
          code: `type Timer = ReturnType<typeof setTimeout>;`,
          filename: island,
        },
      ],
      invalid: [
        ambient(`export const now = Date.now();`, 'Date.now'),
        ambient(`export const now = new Date();`, 'new Date()'),
        ambient(`export const now = Date();`, 'Date()'),
        ambient(`export const now = performance.now();`, 'performance.now'),
        ambient(`export const now = process.hrtime();`, 'process.hrtime'),
        ambient(
          `export const now = process.hrtime.bigint();`,
          'process.hrtime',
        ),
        ambient(
          `export const limit = AbortSignal.timeout(10);`,
          'AbortSignal.timeout',
        ),
        ambient(`setTimeout(() => {}, 10);`, 'setTimeout'),
        ambient(`setInterval(() => {}, 10);`, 'setInterval'),
        ambient(`globalThis.setTimeout(() => {}, 10);`, 'setTimeout'),
        ambient(`global.setTimeout(() => {}, 10);`, 'setTimeout'),
        ambient(`export const now = globalThis.Date.now();`, 'Date.now'),
        ambient(`export const now = global.Date.now();`, 'Date.now'),
        ambient(`export const now = new globalThis.Date();`, 'new Date()'),
        ambient(
          `export const now = globalThis.performance.now();`,
          'performance.now',
        ),
        ambient(
          `export const now = globalThis.process.hrtime();`,
          'process.hrtime',
        ),
        ambient(`export const now = Temporal.Now.instant();`, 'Temporal.Now'),
        // A time source as a value, not called here.
        ambient(
          `import { promisify } from 'node:util'; export const sleep = promisify(setTimeout);`,
          'setTimeout',
        ),
        ambient(
          `export function stamp(now = Date.now) { return now(); }`,
          'Date.now',
        ),
        ambient(`export const read = performance.now;`, 'performance.now'),
        ambient(
          `export const limit = AbortSignal.timeout;`,
          'AbortSignal.timeout',
        ),
        timers(
          `import { performance } from 'perf_hooks';`,
          'performance',
          'perf_hooks',
        ),
        timers(
          `import { setTimeout } from 'node:timers/promises';`,
          'setTimeout',
          'node:timers/promises',
        ),
        timers(
          `import { setTimeout } from 'timers/promises';`,
          'setTimeout',
          'timers/promises',
        ),
        timers(
          `import { setInterval } from 'timers';`,
          'setInterval',
          'timers',
        ),
        timers(
          `import { scheduler } from 'node:timers/promises';`,
          'scheduler',
          'node:timers/promises',
        ),
        timers(
          `import * as timers from 'node:timers';`,
          'the module',
          'node:timers',
        ),
        timers(
          `import timers from 'node:timers/promises';`,
          'the module',
          'node:timers/promises',
        ),
        timers(
          `import { performance } from 'node:perf_hooks';`,
          'performance',
          'node:perf_hooks',
        ),
        {
          code: `setTimeout(() => {}, 10);`,
          filename: workspace.path('packages/library/src/index.ts'),
          settings: libraries,
          errors: [{ messageId: 'ambient', data: { read: 'setTimeout' } }],
        },
      ],
    },
  );
});
