import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { relative } from 'node:path';
import { describe, test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const RULE = 'zukhruf/no-allow-default-project';

/**
 * Lints `paths` of a workspace whose tsconfig.json includes only src/, with
 * `zukhruf/base` and then `block`, and returns every finding as [file, this
 * rule's message, or another rule's id, or a parsing error]. Each call is its
 * own ESLint process, so each gets its own project service.
 */
async function findings(
  block: string,
  paths: string[],
): Promise<[string, string][]> {
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [] },
      include: ['src'],
    }),
    'src/index.ts': 'export const answer = 42;\n',
    'src/tool.js': 'export const answer = 42;\n',
    'vite.config.ts': "export default { root: 'src' };\n",
    'eslint.config.mjs': fixtureConfig(
      [`{ plugins: { zukhruf }, extends: ['zukhruf/base'] }`, block]
        .filter(Boolean)
        .join(',\n'),
    ),
  });
  return (await lint(workspace.root, paths)).map(
    ({ file, ruleId, message }) => [
      relative(workspace.root, file),
      ruleId === RULE ? message : (ruleId ?? message),
    ],
  );
}

// Each test starts processes of its own over a workspace of its own, so the
// tests run at the same time, as many as this machine's processors.
describe(
  'no-allow-default-project',
  { concurrency: availableParallelism() },
  () => {
    test('a non-empty allowDefaultProject is reported on each file whose parser options carry it, with what to do', async () => {
      // Act
      const reported = await findings(
        `{
      files: ['*.config.ts'],
      languageOptions: {
        parserOptions: { projectService: { allowDefaultProject: ['*.config.ts'] } },
      },
    }`,
        ['vite.config.ts', 'src/index.ts'],
      );

      // Assert
      assert.deepEqual(reported, [
        [
          'vite.config.ts',
          "allowDefaultProject ['*.config.ts'] lets typed lint parse a file that no tsconfig includes through typescript-eslint's default project, so lint passes while tsc never type-checks the file and Nx's typecheck inputs leave it out. Include the file in a tsconfig that the project's tsconfig.json references, such as a type-check-only tsconfig.scripts.json, then remove allowDefaultProject.",
        ],
      ]);
    });

    test('an empty allowDefaultProject, the projectService: true of zukhruf/base, and a file with no projectService are not reported', async () => {
      // Act
      const empty = await findings(
        `{
      files: ['**/*.ts'],
      languageOptions: { parserOptions: { projectService: { allowDefaultProject: [] } } },
    }`,
        ['src/index.ts'],
      );
      const base = await findings('', ['src/index.ts', 'src/tool.js']);

      // Assert
      assert.deepEqual(empty, []);
      assert.deepEqual(base, []);
    });
  },
);
