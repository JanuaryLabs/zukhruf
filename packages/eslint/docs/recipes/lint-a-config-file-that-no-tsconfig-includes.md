# Recipe: Lint a config file that no tsconfig includes

**Use case.** A repo uses the `base` config, which turns on typed lint. Typed lint gives each TypeScript file the types of its nearest `tsconfig.json`, so each linted TypeScript file must be in a tsconfig (see [Configs](../../README.md#configs)). A tsconfig usually includes only `src`. The config files at the workspace root, such as `vite.config.ts`, and the hook scripts in `.husky/` are in no tsconfig. ESLint then stops on each of them with "was not found by the project service". typescript-eslint's `allowDefaultProject` makes that error go away, but then tsc never type-checks the files, so `base` refuses it with `zukhruf/no-allow-default-project`. Put the files in a tsconfig instead.

**What you need.** `@zukhruf/eslint` with the `base` config, and its peers `typescript-eslint` and `typescript` (see [Use it](../../README.md#use-it)).

## The steps

1. Find the TypeScript files that ESLint lints and that no tsconfig includes. ESLint reports each one with "was not found by the project service".
2. Next to the project's `tsconfig.json`, add a type-check-only `tsconfig.scripts.json` that includes those files, such as `'*.config.ts'` and `'.husky/*.ts'`. Give it an `outDir` under `out-tsc`, never `dist`, so no build ships its output.
3. Add `{ "path": "./tsconfig.scripts.json" }` to the `references` of the project's `tsconfig.json`.
4. Remove every `allowDefaultProject` block from the ESLint config.

## The program

The program makes a small workspace twice, with `src/index.ts`, `vite.config.ts` and `.husky/pre-commit.ts`. `vite.config.ts` has a type error. The first run includes only `src` in its tsconfig and gives the other two files `allowDefaultProject`. The second run references a `tsconfig.scripts.json` that includes them. Each run lints the three files with the `base` config and then runs `tsc --build`. Each run has its own process, because typescript-eslint keeps one project service for each process.

```ts title="config-file-outside-tsconfig.ts"
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

import { ESLint } from 'eslint';

// TypeScript names its compiler in the bin of its manifest (tsc6 in 6.0).
const require = createRequire(import.meta.url);
const manifest = require.resolve('typescript/package.json');
const [bin] = Object.values(require(manifest).bin);
const tsc = join(dirname(manifest), bin);

const compilerOptions = {
  strict: true,
  module: 'nodenext',
  composite: true,
  emitDeclarationOnly: true,
};

// Two ways to lint vite.config.ts and .husky/pre-commit.ts, which the
// tsconfig of src does not include. Each run gives the files of the workspace
// that differ.
const runs: Record<string, Record<string, string>> = {
  allowDefaultProject: {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { ...compilerOptions, outDir: 'out-tsc' },
      include: ['src'],
    }),
    'eslint.config.mjs': rootConfig(`{
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.config.ts', '.husky/*.ts'] },
      },
    },
  }`),
  },
  'tsconfig.scripts.json': {
    // A solution-style tsconfig.json: the project service and tsc --build
    // both follow its references.
    'tsconfig.json': JSON.stringify({
      files: [],
      references: [
        { path: './tsconfig.lib.json' },
        { path: './tsconfig.scripts.json' },
      ],
    }),
    'tsconfig.lib.json': JSON.stringify({
      compilerOptions: { ...compilerOptions, outDir: 'out-tsc/lib' },
      include: ['src'],
    }),
    // Type-check only: its output goes to out-tsc, never to dist.
    'tsconfig.scripts.json': JSON.stringify({
      compilerOptions: { ...compilerOptions, outDir: 'out-tsc/scripts' },
      include: ['*.config.ts', '.husky/*.ts'],
    }),
    'eslint.config.mjs': rootConfig(''),
  },
};

function rootConfig(block: string): string {
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
      'src/index.ts': 'export const answer = 42;\n',
      // A type error that only tsc reports.
      'vite.config.ts':
        "const port: number = '5173';\nexport default { server: { port } };\n",
      '.husky/pre-commit.ts': "console.log('pre-commit');\n",
      ...runs[run],
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
      const messages = result.messages.map(
        ({ ruleId, message }) => ruleId ?? message.split('\n')[0],
      );
      console.log(
        `  lint ${relative(root, result.filePath)}: ${messages.join('; ') || 'no finding'}`,
      );
    }
    const typecheck = spawnSync(process.execPath, [tsc, '--build'], {
      cwd: root,
      encoding: 'utf8',
    });
    // 0: no error, 2: errors in the projects; anything else is a broken run.
    if (typecheck.status !== 0 && typecheck.status !== 2)
      throw new Error(`tsc --build failed: ${typecheck.stderr}`);
    console.log(`  tsc --build: ${typecheck.stdout.trim() || 'no error'}`);
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

Output with ESLint 10.15.0, typescript-eslint 8.73.0, TypeScript 6.0.2 and Node 26.13.0:

```
allowDefaultProject:
  lint .husky/pre-commit.ts: zukhruf/no-allow-default-project
  lint src/index.ts: zukhruf/no-allow-default-project
  lint vite.config.ts: zukhruf/no-allow-default-project
  tsc --build: no error
tsconfig.scripts.json:
  lint .husky/pre-commit.ts: no finding
  lint src/index.ts: no finding
  lint vite.config.ts: no finding
  tsc --build: vite.config.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.
```

## What the output shows

- **With `allowDefaultProject`, lint passes on the type error and tsc never sees it.** typescript-eslint parses `vite.config.ts` through its default project, so lint runs on it, but no tsconfig includes the file, so `tsc --build` reports no error. `zukhruf/no-allow-default-project` reports each file whose parser options carry the list. The block covers `**/*.ts`, so `src/index.ts` is reported too.
- **With `tsconfig.scripts.json`, lint and tsc both see the files.** Lint finds nothing, and `tsc --build` reports the type error in `vite.config.ts`.

## Why it works

The project service of typescript-eslint finds the nearest tsconfig of each file, and follows the `references` of a solution-style `tsconfig.json` (one with `"files": []`) to the tsconfig that includes the file. `tsc --build` follows the same references, and so does the `typecheck` target that `@nx/js/typescript` infers from `tsconfig.json`, which lists the files in its inputs. A file in `allowDefaultProject` gets the types of typescript-eslint's default project instead ([`allowDefaultProject`](https://typescript-eslint.io/packages/parser/#allowdefaultproject)). No tsconfig includes it, so tsc never checks it, and a change to it does not invalidate the `typecheck` cache. In Meddit this hid a live type error (`packages/db/scripts/rxnav-concepts.ts`, TS2536) until its commit 3b389d6 gave each such file a `tsconfig.scripts.json`.

## Things to know

- **Without `allowDefaultProject`, typescript-eslint already refuses a file in no tsconfig.** It stops with "was not found by the project service" (`useProgramFromProjectService.js` of `@typescript-eslint/typescript-estree`, line 95). `zukhruf/no-allow-default-project` closes the one way around that error.
- **typescript-eslint keeps one project service for each process.** The service has the options of the first file that it parses (`createParseSettings.js` of `@typescript-eslint/typescript-estree`, line 323). The rule reads the parser options of each file, so it reports every file that a block with `allowDefaultProject` covers, whichever file the service saw first.
- **The rule tester of this package keeps its default project.** `typedRuleTester()` in `src/testing/rule-tester.ts` gives the virtual files of rule tests `allowDefaultProject: ['*.ts']`. A rule test runs only its own rule, so `zukhruf/no-allow-default-project` never sees those options.
