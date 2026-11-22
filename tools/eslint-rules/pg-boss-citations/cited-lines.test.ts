import { test } from 'node:test';

import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';

import rule from './cited-lines.ts';
import { fixtureWorkspace } from './testing/fixture-workspace.ts';

// A package that pins pg-boss, with pg-boss installed as npm installs it: a
// manager.js of 10 lines and an adapters/pglite.js of 3 lines.
const installed = (version: string) => ({
  'queue/package.json': JSON.stringify({
    name: '@acme/queue',
    dependencies: { 'pg-boss': '12.39.0' },
  }),
  'node_modules/pg-boss/package.json': JSON.stringify({
    name: 'pg-boss',
    version,
    type: 'module',
    exports: { '.': './dist/index.js' },
  }),
  'node_modules/pg-boss/dist/index.js': 'export {};\n',
  'node_modules/pg-boss/dist/manager.js': 'line\n'.repeat(10),
  'node_modules/pg-boss/dist/adapters/pglite.js': 'line\n'.repeat(3),
});

const tester = () =>
  new RuleTester({ languageOptions: { parser: tseslint.parser } });

test('a cited line past the end of its file is reported at its numbers, however the citation is written', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace(installed('12.39.0'));
  const filename = workspace.path('queue/src/queue.ts');
  const pastEnd = (range: string, line: number, column: number) => ({
    messageId: 'pastEnd',
    data: { file: 'manager.js', range, lines: '10', version: '12.39.0' },
    line,
    column,
    endColumn: column + range.length,
  });

  // Act + Assert
  tester().run('cited-lines', rule, {
    valid: [],
    invalid: [
      { code: '// manager.js:11', filename, errors: [pastEnd('11', 1, 15)] },
      {
        code: 'const a = 1; // (node_modules/pg-boss/dist/manager.js:2-12)',
        filename,
        errors: [pastEnd('2-12', 1, 55)],
      },
      {
        code: '// see manager.js:1-2, 9-14',
        filename,
        errors: [pastEnd('9-14', 1, 24)],
      },
      {
        code: '// as pg-boss does (manager.js:\n// 40-41).',
        filename,
        errors: [pastEnd('40-41', 2, 4)],
      },
      {
        code: '/**\n * as pg-boss does (manager.js:\n * 40-41).\n */\nexport {};',
        filename,
        errors: [pastEnd('40-41', 3, 4)],
      },
      {
        code: '// manager.js:2 and its fragments\n// (5, 30-31)',
        filename,
        errors: [pastEnd('30-31', 2, 8)],
      },
      {
        code: '// (manager.js:2, :12)',
        filename,
        errors: [pastEnd('12', 1, 20)],
      },
      {
        code: 'const schema = `\n  id TEXT, -- (manager.js:1)\n  -- as pg-boss does (manager.js:\n  -- 40-41)\n`;',
        filename,
        errors: [pastEnd('40-41', 4, 6)],
      },
      {
        code: "const note = 'see -- manager.js:12';",
        filename,
        errors: [pastEnd('12', 1, 33)],
      },
    ],
  });
});

test('a citation of a file that is not in the dist is reported', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace(installed('12.39.0'));
  const filename = workspace.path('queue/src/queue.ts');
  const missingFile = (file: string) => ({
    messageId: 'missingFile',
    data: { file, version: '12.39.0' },
  });

  // Act + Assert
  tester().run('cited-lines', rule, {
    valid: [],
    invalid: [
      {
        code: '// nosuch.js:1 and adapters/postgres.js:1',
        filename,
        errors: [missingFile('nosuch.js'), missingFile('adapters/postgres.js')],
      },
    ],
  });
});

test('citations within their files pass, and so do the numbers that cite no pg-boss line', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace(installed('12.39.0'));
  const filename = workspace.path('queue/src/queue.ts');

  // Act + Assert
  tester().run('cited-lines', rule, {
    valid: [
      { code: '// manager.js:1-10, adapters/pglite.js:3', filename },
      // pg is not pinned, so its lines are not checked.
      { code: '// (node_modules/pg/lib/client.js:400-420)', filename },
      {
        code: '// node_modules/pg-protocol/dist/messages.js:36\n// (500)',
        filename,
      },
      // A call in a comment is not a follow-on, nor is a group on the line
      // of the citation, nor one after a line of code.
      { code: '// manager.js:2: tick(0) and\n// .slice(0, 24)', filename },
      { code: '// manager.js:2 (and (99))', filename },
      { code: '// manager.js:2\nconst a = 1;\n// (99)', filename },
      // A `--` in a string is read only for the citation grammar.
      { code: "const range = 'a -- b (99), 1-99';", filename },
      { code: 'const sql = `SELECT 1 -- (99)`;', filename },
    ],
    invalid: [],
  });
});

test('an installed pg-boss that is not the pinned one is reported once, and its lines are not checked', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace(installed('12.38.2'));
  const filename = workspace.path('queue/src/queue.ts');

  // Act + Assert
  tester().run('cited-lines', rule, {
    valid: [{ code: '// no citation here', filename }],
    invalid: [
      {
        code: '// manager.js:99 and nosuch.js:1',
        filename,
        errors: [
          {
            messageId: 'notInstalled',
            data: { installed: '12.38.2', pinned: '12.39.0' },
            line: 1,
            column: 15,
          },
        ],
      },
    ],
  });
});
