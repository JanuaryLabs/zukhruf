import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { describe, test } from 'node:test';

import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import { Command } from '@zukhruf/process';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './timers-promises-set-immediate.ts';

const oneTurn = [{ messageId: 'oneTurn' }];
const immediateTaken = [{ messageId: 'immediateTaken' }];
const IMPORT = `import { setImmediate } from 'node:timers/promises';`;

// RuleTester applies one pass. `eslint --fix` runs this loop until no fix is
// left, and a file with several sites needs more than one pass.
function fixAllPasses(code: string): string {
  return new Linter({ configType: 'flat' }).verifyAndFix(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: {
          'modern-node': { rules: { 'timers-promises-set-immediate': rule } },
        },
        rules: { 'modern-node/timers-promises-set-immediate': 'error' },
      },
    ],
    { filename: 'file.ts' },
  ).output;
}

async function outputOfProgram(code: string): Promise<string> {
  const run = await new Command(
    process.execPath,
    ['--input-type=module', '--eval', code],
    { env: process.env, clock: globalThis },
  ).run();
  assert.equal(run.exitCode, 0, run.stderr);
  return run.stdout;
}

// Each test starts processes of its own over a workspace of its own, so the
// tests run at the same time, as many as this machine's processors.
describe(
  'timers-promises-set-immediate',
  { concurrency: availableParallelism() },
  () => {
    test('the fixed program runs its steps in the order the original program runs them', async () => {
      // Arrange
      const code = [
        `import { setTimeout as sleep } from 'node:timers/promises';`,
        `const steps = [];`,
        `globalThis.setImmediate(() => steps.push('queued immediate'));`,
        `queueMicrotask(() => steps.push('microtask'));`,
        `process.nextTick(() => steps.push('tick'));`,
        `await new Promise((resolve) => setImmediate(resolve));`,
        `steps.push('first turn');`,
        `Promise.resolve().then(() => steps.push('reaction'));`,
        `await new Promise((resolve) => { setImmediate(() => resolve()); });`,
        `steps.push('second turn');`,
        `await sleep(1);`,
        `console.log(steps.join(','));`,
      ].join('\n');

      // Act
      const fixed = fixAllPasses(code);

      // Assert
      assert.doesNotMatch(fixed, /new Promise/u);
      assert.equal(await outputOfProgram(fixed), await outputOfProgram(code));
    });

    test('eslint --fix on three sites adds one import and replaces each site', () => {
      // Arrange
      const code = `import { test } from 'node:test';\nawait new Promise((resolve) => setImmediate(resolve));\ntest('a', async () => {\n  await new Promise((r) => setImmediate(r));\n});\nawait new Promise<void>((resolve) => setImmediate(resolve));`;

      // Act
      const fixed = fixAllPasses(code);

      // Assert
      assert.equal(
        fixed,
        `import { test } from 'node:test';\n${IMPORT}\nawait setImmediate();\ntest('a', async () => {\n  await setImmediate();\n});\nawait setImmediate();`,
      );
    });

    test('each form that resolves after one turn with no value is reported and fixed', () => {
      typescriptRuleTester().run('timers-promises-set-immediate', rule, {
        valid: [],
        invalid: [
          {
            code: `await new Promise((resolve) => setImmediate(resolve));`,
            output: `${IMPORT}\nawait setImmediate();`,
            errors: oneTurn,
          },
          {
            code: `await new Promise((resolve) => { setImmediate(resolve); });`,
            output: `${IMPORT}\nawait setImmediate();`,
            errors: oneTurn,
          },
          {
            code: `await new Promise((resolve) => setImmediate(() => resolve()));`,
            output: `${IMPORT}\nawait setImmediate();`,
            errors: oneTurn,
          },
          {
            code: `await new Promise(function (resolve) { setImmediate(() => { resolve(); }); });`,
            output: `${IMPORT}\nawait setImmediate();`,
            errors: oneTurn,
          },
          {
            code: `const turn = () => new Promise<void>((resolve) => setImmediate(resolve));`,
            output: `${IMPORT}\nconst turn = () => setImmediate();`,
            errors: oneTurn,
          },
        ],
      });
    });

    test('the fix uses the import of node:timers/promises that the file already has', () => {
      typescriptRuleTester().run('timers-promises-set-immediate', rule, {
        valid: [],
        invalid: [
          {
            code: `import { setImmediate as nextTurn } from 'node:timers/promises';\nawait new Promise((resolve) => setImmediate(resolve));`,
            output: `import { setImmediate as nextTurn } from 'node:timers/promises';\nawait nextTurn();`,
            errors: oneTurn,
          },
          {
            code: `import * as timers from 'timers/promises';\nawait new Promise((resolve) => setImmediate(resolve));`,
            output: `import * as timers from 'timers/promises';\nawait timers.setImmediate();`,
            errors: oneTurn,
          },
          {
            code: `import { setTimeout as sleep } from 'node:timers/promises';\nawait new Promise((resolve) => setImmediate(resolve));`,
            output: `import { setTimeout as sleep, setImmediate } from 'node:timers/promises';\nawait setImmediate();`,
            errors: oneTurn,
          },
        ],
      });
    });

    test('a global setImmediate that stays blocks the fix, because the import would capture it', () => {
      typescriptRuleTester().run('timers-promises-set-immediate', rule, {
        valid: [],
        invalid: [
          {
            code: `await new Promise((resolve) => setImmediate(resolve));\nsetImmediate(() => controller.abort());`,
            output: null,
            errors: immediateTaken,
          },
        ],
      });
    });

    test('a comment inside the site, a script file, or a name that hides the import blocks the fix', () => {
      typescriptRuleTester().run('timers-promises-set-immediate', rule, {
        valid: [],
        invalid: [
          {
            code: `import { setImmediate as nextTurn } from 'node:timers/promises';\nexport const turn = (nextTurn) => new Promise((resolve) => setImmediate(resolve));`,
            output: null,
            errors: oneTurn,
          },
          {
            code: `await new Promise((resolve) =>\n  // After the write.\n  setImmediate(resolve));`,
            output: null,
            errors: oneTurn,
          },
          {
            code: `new Promise((resolve) => setImmediate(resolve)).then(next);`,
            output: null,
            errors: oneTurn,
            languageOptions: { sourceType: 'script' },
          },
        ],
      });
    });

    test('a value, a callback that does more, or a setImmediate or Promise that is not the global is left alone', () => {
      typescriptRuleTester().run('timers-promises-set-immediate', rule, {
        valid: [
          // The marker of a race, which zukhruf/no-timer-race reads.
          {
            code: `await Promise.race([work, new Promise((r) => setImmediate(r, 'pending'))]);`,
          },
          {
            code: `await new Promise((resolve) => setImmediate(() => resolve(read())));`,
          },
          {
            code: `await new Promise((resolve) => setImmediate(() => { flush(); resolve(); }));`,
          },
          {
            code: `await new Promise((resolve) => { count += 1; setImmediate(resolve); });`,
          },
          { code: `await new Promise((resolve) => setTimeout(resolve, 0));` },
          {
            code: `import { setImmediate } from 'node:timers';\nawait new Promise((resolve) => setImmediate(resolve));`,
          },
          {
            code: `function setImmediate(fn) { queue.push(fn); }\nawait new Promise((resolve) => setImmediate(resolve));`,
          },
          {
            code: `import Promise from 'bluebird';\nawait new Promise((resolve) => setImmediate(resolve));`,
          },
        ],
        invalid: [],
      });
    });
  },
);
