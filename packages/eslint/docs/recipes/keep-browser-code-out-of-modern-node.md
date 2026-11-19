# Recipe: Keep browser code out of modern-node in a workspace whose projects spread the root config

**Use case.** A workspace has Node projects and browser projects. The root `eslint.config.mjs` turns on `modern-node/recommended`, and its `ignores` names the browser projects. Some projects have their own `eslint.config.mjs`, which spreads the root config. The fixes of Modern Node, such as `Error.isError`, can throw in a browser, so the browser code must stay out of the config. In a project that spreads the root config, `ignores` in the root matches nothing, and Modern Node reports the browser code.

**What you need.** `@zukhruf/eslint/modern-node`, ESLint 10, and its peers `@e18e/eslint-plugin` and `eslint-plugin-unicorn` (see [Modern Node](../../README.md#modern-node)).

## The steps

1. Find the browser projects that have their own `eslint.config`, which spreads the root config.
2. Select one of the two approaches that hold:
   - In the root config, give the Modern Node block `basePath: import.meta.dirname`. Keep the browser globs in its `ignores`.
   - Do not turn on Modern Node in the root config. Add it to the config of each Node project.
3. Check the result with `eslint --print-config <file>` on a file of a browser project.

## The program

The program makes a small workspace three times, one time for each approach. `packages/web` runs in a browser and has its own config, which spreads the root config. `packages/server` runs on Node. The two projects have the same code, which `unicorn/prefer-error-is-error` reports. The program lints the two files with ESLint and prints the findings.

```ts title="browser-code-and-modern-node.ts"
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { ESLint } from 'eslint';

// The same code in two projects: packages/web runs in a browser, and
// packages/server runs on Node. unicorn/prefer-error-is-error reports it.
const code = 'export const isError = (value) => value instanceof Error;\n';

// packages/web has its own eslint.config, which spreads the root config.
const webConfig = [
  "import root from '../../eslint.config.mjs';",
  'export default [...root];',
].join('\n');

function rootConfig(block: string): string {
  return [
    "import modernNode from '@zukhruf/eslint/modern-node';",
    "import { defineConfig } from 'eslint/config';",
    'export default defineConfig(',
    block,
    ');',
  ].join('\n');
}

const approaches: Record<string, Record<string, string>> = {
  'ignores in the root config': {
    'eslint.config.mjs': rootConfig(`  {
    ignores: ['packages/web/**'],
    plugins: { 'modern-node': modernNode },
    extends: ['modern-node/recommended'],
  },`),
  },
  'ignores with basePath in the root config': {
    'eslint.config.mjs': rootConfig(`  {
    basePath: import.meta.dirname,
    ignores: ['packages/web/**'],
    plugins: { 'modern-node': modernNode },
    extends: ['modern-node/recommended'],
  },`),
  },
  'the config in each Node project': {
    'eslint.config.mjs': "export default [{ ignores: ['**/dist'] }];",
    'packages/server/eslint.config.mjs': [
      "import modernNode from '@zukhruf/eslint/modern-node';",
      "import { defineConfig } from 'eslint/config';",
      "import root from '../../eslint.config.mjs';",
      'export default defineConfig(...root, {',
      "  plugins: { 'modern-node': modernNode },",
      "  extends: ['modern-node/recommended'],",
      '});',
    ].join('\n'),
  },
};

for (const [approach, files] of Object.entries(approaches)) {
  // The workspace is beside this program, so its configs resolve the
  // packages from the node_modules of this folder.
  const root = await mkdtemp(join(import.meta.dirname, 'workspace-'));
  try {
    const workspace: Record<string, string> = {
      'packages/web/eslint.config.mjs': webConfig,
      'packages/web/src/app.js': code,
      'packages/server/src/main.js': code,
      ...files,
    };
    for (const [path, text] of Object.entries(workspace)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }

    const results = await new ESLint({ cwd: root }).lintFiles([
      'packages/*/src/*.js',
    ]);

    console.log(`${approach}:`);
    for (const result of results.toSorted((a, b) =>
      a.filePath.localeCompare(b.filePath),
    )) {
      const rules = result.messages.map(({ ruleId }) => ruleId);
      console.log(
        `  ${relative(root, result.filePath)}: ${rules.join(', ') || 'no finding'}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
```

Run it from a folder that has the workspace's `node_modules`, as `node --conditions=@zukhruf/source browser-code-and-modern-node.ts`.

Output with ESLint 10.12.0 on Node 26.13.0:

```
ignores in the root config:
  packages/server/src/main.js: unicorn/prefer-error-is-error
  packages/web/src/app.js: unicorn/prefer-error-is-error
ignores with basePath in the root config:
  packages/server/src/main.js: unicorn/prefer-error-is-error
  packages/web/src/app.js: no finding
the config in each Node project:
  packages/server/src/main.js: unicorn/prefer-error-is-error
  packages/web/src/app.js: no finding
```

## What the output shows

- **`ignores` in the root config does not hold.** Modern Node reports `packages/web/src/app.js`, the browser code.
- **`ignores` with `basePath` holds.** Modern Node reports only the Node code.
- **The config in each Node project holds.** Modern Node reports only the Node code. This is the approach of the [Modern Node](../../README.md#modern-node) section of the README (commit `d9243da4`, #4065).

## Why it works

ESLint 10 lints each file with the config file nearest to the file ([configuration file resolution](https://eslint.org/docs/latest/use/configure/configuration-files#configuration-file-resolution)). For `packages/web/src/app.js`, that is `packages/web/eslint.config.mjs`. ESLint resolves the globs of each config object from the folder of the config file that it loaded. The config of `packages/web` spreads the root config, so the root's glob `packages/web/**` becomes `packages/web/packages/web/**`, and it matches nothing.

`basePath` sets the folder from which ESLint resolves the globs of one config object ([specify base path](https://eslint.org/docs/latest/use/configure/configuration-files#specify-base-path)). `import.meta.dirname` in the root config is the folder of the root config. Thus the glob resolves from the root, also when a project config spreads the root config.

When only the Node projects turn on Modern Node, no glob has to name the browser code.

## Things to know

- **Two repos of the rollout write the `ignores` block in the root config.** deepagents adds `basePath: import.meta.dirname` (`eslint.config.mjs`, lines 27-65), so its globs hold in `packages/react/genai`, which spreads the root config. context-compiler has no `basePath` (`eslint.config.mjs`, lines 59-74); its comment says that the globs match nothing in `apps/ambient`, a Node project that spreads the root config.
- **The package cannot set `basePath` for a repo.** Only the repo knows the path of its root. [ADR 0002](../adr/0002-scope-from-the-linted-file.md) lists `basePath` on each config object as an option that lost for the rules of the package for this reason.
- **`basePath` holds for one config object.** Give it to each block of the root config whose globs must hold in a project config.
- **A config with `extends` needs `defineConfig`.** A plain array with `extends` makes ESLint stop with "Key "extends": This appears to be in eslintrc format rather than flat config format".
