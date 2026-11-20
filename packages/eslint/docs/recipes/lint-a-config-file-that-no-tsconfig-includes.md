# Recipe: Lint a config file that no tsconfig includes

**Use case.** A repo uses the `base` config, which turns on typed lint. Typed lint gives each TypeScript file the types of its nearest `tsconfig.json`, so each linted TypeScript file must be in a tsconfig (see [Configs](../../README.md#configs)). A tsconfig usually includes only `src`. The config files at the workspace root, such as `vite.config.ts`, and the hook scripts in `.husky/` are in no tsconfig. ESLint then stops on each of them with a parsing error, and lints nothing in them.

**What you need.** `@zukhruf/eslint` with the `base` config, and its peers `typescript-eslint` and `typescript` (see [Use it](../../README.md#use-it)).

## The steps

1. Find the TypeScript files that ESLint lints and that no tsconfig includes. ESLint reports each one with "was not found by the project service".
2. In the root `eslint.config.mjs`, add a block after `zukhruf/base` for `files: ['**/*.ts']`. Set `languageOptions.parserOptions.projectService.allowDefaultProject` to a list of globs for those files.
3. Write each glob relative to the workspace root, with a single `*` for each folder level, such as `'*.config.ts'`, `'.husky/*.ts'` and `'apps/*/sdk-it.config.ts'`. Do not write `**`.

## The program

The program makes a small workspace three times. Its tsconfig includes only `src`. The workspace also has `vite.config.ts` and `.husky/pre-commit.ts`. The program lints the three files with the `base` config, first with no `allowDefaultProject`, then with single-`*` globs, then with a `**` glob. Each run has its own process, because typescript-eslint keeps one project service for each process.

```ts title="config-file-outside-tsconfig.ts"
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { ESLint } from 'eslint';

// The repo's own block for the files that no tsconfig includes. Each run
// gives it a different value, or leaves it out.
const runs: Record<string, string[] | undefined> = {
  'no allowDefaultProject': undefined,
  "allowDefaultProject ['*.config.ts', '.husky/*.ts']": [
    '*.config.ts',
    '.husky/*.ts',
  ],
  "allowDefaultProject ['**/*.config.ts']": ['**/*.config.ts'],
};

function rootConfig(allowDefaultProject?: string[]): string {
  const block = allowDefaultProject
    ? `{
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ${JSON.stringify(allowDefaultProject)},
        },
      },
    },
  },`
    : '';
  return [
    "import zukhruf from '@zukhruf/eslint';",
    "import { defineConfig } from 'eslint/config';",
    'export default defineConfig(',
    "  { plugins: { zukhruf }, extends: ['zukhruf/base'] },",
    `  ${block}`,
    ');',
  ].join('\n');
}

async function lint(run: string): Promise<void> {
  // The workspace is beside this program, so its config resolves the
  // packages from the node_modules of this folder.
  const root = await mkdtemp(join(import.meta.dirname, 'workspace-'));
  try {
    const workspace: Record<string, string> = {
      'package.json': JSON.stringify({ type: 'module', workspaces: [] }),
      // The tsconfig includes only src, as in most projects.
      'tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true, module: 'nodenext', noEmit: true },
        include: ['src'],
      }),
      'src/index.ts': 'export const answer = 42;\n',
      'vite.config.ts': "export default { root: 'src' };\n",
      '.husky/pre-commit.ts': "console.log('pre-commit');\n",
      'eslint.config.mjs': rootConfig(runs[run]),
    };
    for (const [path, text] of Object.entries(workspace)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }

    // base takes the workspace root from the folder where ESLint runs.
    process.chdir(root);
    const results = await new ESLint({ cwd: root }).lintFiles([
      'src/index.ts',
      'vite.config.ts',
      '.husky/pre-commit.ts',
    ]);

    console.log(`${run}:`);
    for (const result of results.toSorted((a, b) =>
      a.filePath.localeCompare(b.filePath),
    )) {
      // A parsing error has no rule. Print its first line without the path.
      const messages = result.messages.map(
        ({ ruleId, message }) =>
          ruleId ?? message.split('\n')[0].replace(result.filePath, '<file>'),
      );
      console.log(
        `  ${relative(root, result.filePath)}: ${messages.join('; ') || 'no finding'}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const [run] = process.argv.slice(2);
if (run === undefined) {
  // typescript-eslint makes one project service for each process, with the
  // options of the first file it parses. So each run gets its own process.
  for (const name of Object.keys(runs)) {
    process.stdout.write(
      execFileSync(
        process.execPath,
        [...process.execArgv, import.meta.filename, name],
        { encoding: 'utf8' },
      ),
    );
  }
} else {
  await lint(run);
}
```

Run it from a folder that has the workspace's `node_modules`, as `node --conditions=@zukhruf/source config-file-outside-tsconfig.ts`.

Output with ESLint 10.12.0, typescript-eslint 8.72.1 and Node 26.13.0:

```
no allowDefaultProject:
  .husky/pre-commit.ts: Parsing error: <file> was not found by the project service. Consider either including it in the tsconfig.json or including it in allowDefaultProject.
  src/index.ts: no finding
  vite.config.ts: Parsing error: <file> was not found by the project service. Consider either including it in the tsconfig.json or including it in allowDefaultProject.
allowDefaultProject ['*.config.ts', '.husky/*.ts']:
  .husky/pre-commit.ts: no finding
  src/index.ts: no finding
  vite.config.ts: no finding
allowDefaultProject ['**/*.config.ts']:
  .husky/pre-commit.ts: Parsing error: allowDefaultProject glob '**/*.config.ts' contains a disallowed '**'.
  src/index.ts: Parsing error: allowDefaultProject glob '**/*.config.ts' contains a disallowed '**'.
  vite.config.ts: Parsing error: allowDefaultProject glob '**/*.config.ts' contains a disallowed '**'.
```

## What the output shows

- **With no `allowDefaultProject`, ESLint lints only the files in the tsconfig.** `vite.config.ts` and `.husky/pre-commit.ts` get a parsing error, and no rule runs on them.
- **Single-`*` globs give the two files the default project.** ESLint lints all three files, and finds nothing.
- **A `**` glob stops typed lint for every file.** typescript-eslint refuses the glob, so each file gets the parsing error, also `src/index.ts`, which is in the tsconfig.

## Why it works

The project service of typescript-eslint finds the nearest tsconfig of each file. When no tsconfig includes the file, the service gives the file its default project only when a glob of `allowDefaultProject` matches it ([`allowDefaultProject`](https://typescript-eslint.io/packages/parser/#allowdefaultproject)). The default project has the types of the file, with default compiler options.

`base` sets `projectService: true` and `tsconfigRootDir` to the workspace root of the folder where ESLint runs (`src/base/config.ts`, the block `zukhruf/base/typed`). The globs of `allowDefaultProject` resolve from `tsconfigRootDir`, so a glob such as `'.husky/*.ts'` names a path from the workspace root. ESLint merges the `parserOptions` of the two blocks, so the repo's block keeps the `tsconfigRootDir` of `base`.

typescript-eslint refuses `**` in a glob of `allowDefaultProject`: the default project is slow when many files use it ([allowdefaultproject-glob-too-wide](https://tseslint.com/allowdefaultproject-glob-too-wide)). Thus each folder level needs its own single-`*` glob.

## Things to know

- **Six repos of the rollout write this block.** elt (`eslint.config.mjs`, line 157), context-compiler (line 126) and offers-evals (line 203) give `.husky/*.ts`. april (line 87) gives `.husky/*.mts` and `vitest.workspace.ts`. factory (line 78) and whatisgoingon (line 63) give `*.config.ts`, `.husky/*.ts` and a glob for each folder level of their nested config files, such as `apps/*/sdk-it.config.ts` and `apps/*/*/sdk-it.config.ts`; their comment says that typescript-eslint rejects `**`.
- **The default project takes at most 8 files.** When more files match the globs, typescript-eslint stops with "Too many files (>8) have matched the default project" (`DEFAULT_PROJECT_MATCHED_FILES_THRESHOLD` in `@typescript-eslint/project-service`). Put a group of such files in a tsconfig of their own.
- **typescript-eslint keeps one project service for each process.** The service has the options of the first file that it parses (`createParseSettings.js` of `@typescript-eslint/typescript-estree`). A program that lints with different `allowDefaultProject` values must use one process for each value, as the program above does.
