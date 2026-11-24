import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { nodeTypeRoots } from '../testing/node-type-roots.ts';
import { typedRuleTester } from '../testing/rule-tester.ts';
import rule from './require-warning-code.ts';

const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: 'esnext',
    module: 'nodenext',
    lib: ['esnext'],
    types: ['node'],
    typeRoots: nodeTypeRoots,
  },
  include: ['*.ts', '*.mts'],
});

async function workspace() {
  return fixtureWorkspace({
    'tsconfig.json': tsconfig,
    // On disk, so the tsconfig holds the cases: the project service gives at
    // most eight files of a process its default project.
    'case.mts': 'export {};\n',
  });
}

// The shape of ADR 0010 of the zukhruf repository.
const typed = `Object.assign(new Error('The acquire failed, and the selector tries again', { cause: failure }), { name: 'LeaderSelectorWarning', code: 'ZUKHRUF_MUTEX_LEADER_SELECTOR_ACQUIRE_FAILED', detail: 'key: jobs' })`;

test('a warning with no code is reported: a raw failure, a string alone, a string with only a type, and through each import of process', async () => {
  await using fixture = await workspace();
  const filename = fixture.path('case.mts');
  const missingCode = [{ messageId: 'missingCode' }];

  typedRuleTester(fixture.root).run('require-warning-code', rule, {
    valid: [],
    invalid: [
      {
        // The 12 sites of ADR 0010 before #5472.
        filename,
        code: `export function warn(error: unknown) { process.emitWarning(Error.isError(error) ? error : new Error(String(error), { cause: error })); }`,
        errors: missingCode,
      },
      {
        filename,
        code: `process.emitWarning('The cache is cold');`,
        errors: missingCode,
      },
      {
        filename,
        code: `process.emitWarning('The cache is cold', 'CacheWarning');`,
        errors: missingCode,
      },
      {
        filename,
        code: `process.emitWarning('The cache is cold', { type: 'CacheWarning', detail: 'key: jobs' });`,
        errors: missingCode,
      },
      {
        filename,
        code: `process.emitWarning('The cache is cold', function warned() {});`,
        errors: missingCode,
      },
      {
        filename,
        code: `import process from 'node:process'; process.emitWarning('The cache is cold');`,
        errors: missingCode,
      },
      {
        filename,
        code: `import { emitWarning } from 'node:process'; emitWarning('The cache is cold');`,
        errors: missingCode,
      },
      {
        filename,
        code: `globalThis.process.emitWarning(new Error('The cache is cold'));`,
        errors: missingCode,
      },
    ],
  });
});

test('an Error passed with options, a type or a constructor is reported, because Node ignores them', async () => {
  await using fixture = await workspace();
  const filename = fixture.path('case.mts');
  const optionsIgnored = [{ messageId: 'optionsIgnored' }];

  typedRuleTester(fixture.root).run('require-warning-code', rule, {
    valid: [],
    invalid: [
      {
        // Probe B of ADR 0010: the listener still gets name 'Error'.
        filename,
        code: `declare const failure: Error; process.emitWarning(failure, { type: 'LeaderSelectorWarning', code: 'ZUKHRUF_X', detail: 'key: jobs' });`,
        errors: optionsIgnored,
      },
      {
        filename,
        code: `declare const failure: Error; process.emitWarning(failure, 'LeaderSelectorWarning', 'ZUKHRUF_X');`,
        errors: optionsIgnored,
      },
      {
        filename,
        code: `declare const failure: Error; process.emitWarning(failure, function warned() {});`,
        errors: optionsIgnored,
      },
      {
        filename,
        code: `declare const failure: unknown; process.emitWarning(${typed}, { code: 'ZUKHRUF_X' });`,
        errors: optionsIgnored,
      },
    ],
  });
});

test('a warning with a code passes: the typed Error alone, a string with a code in its options or as its third argument, and an emitWarning that is not Node’s', async () => {
  await using fixture = await workspace();
  const filename = fixture.path('case.mts');

  typedRuleTester(fixture.root).run('require-warning-code', rule, {
    valid: [
      {
        filename,
        code: `declare const failure: unknown; process.emitWarning(${typed});`,
      },
      {
        filename,
        code: `import { emitWarning } from 'node:process'; declare const failure: unknown; emitWarning(${typed});`,
      },
      {
        // The deprecation of @zukhruf/eslint's plugin.ts.
        filename,
        code: `process.emitWarning('The config zukhruf/react is now zukhruf/shadcn.', { type: 'DeprecationWarning', code: 'ZUKHRUF_ESLINT_REACT_CONFIG' });`,
      },
      {
        // The deprecation of @zukhruf/sqlite-queue, as pg-boss writes it.
        filename,
        code: `process.emitWarning('priority: false is deprecated', 'DeprecationWarning', 'PGBOSS_DEP_FETCH_SORT');`,
      },
      {
        filename,
        code: `class FetchError extends Error { readonly code = 'UND_ERR_X'; } process.emitWarning(new FetchError('The body is short'));`,
      },
      {
        filename,
        code: `const reporter = { emitWarning(message: string) { return message; } }; reporter.emitWarning('The cache is cold');`,
      },
      {
        filename,
        code: `function emitWarning(message: string) { return message; } emitWarning('The cache is cold');`,
      },
    ],
    invalid: [],
  });
});
