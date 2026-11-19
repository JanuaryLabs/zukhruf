import { resolve } from 'node:path';

import type { Tree } from '@nx/devkit';
import { ESLint, type Linter } from 'eslint';
import { defineConfig } from 'eslint/config';

import zukhruf from '@zukhruf/eslint';

import { changes } from './generator-tree.ts';

const SOURCE = /\.(ts|tsx|mjs|js)$/;

// A folder that does not exist, as in lint-manifests.ts.
const CWD = resolve('/generator-tree');

// The parser of the base config of @zukhruf/eslint, which every generated
// eslint.config.mjs extends. `find` gives undefined when the block is gone, so
// a renamed block fails the tests.
const parser = zukhruf.configs['base']?.find(
  (block) => block.name === 'zukhruf/base/recommended > typescript-eslint/base',
)?.languageOptions?.parser;

function config(): Linter.Config[] {
  if (parser === undefined) {
    throw new Error(
      'The base config of @zukhruf/eslint has no block "zukhruf/base/recommended > typescript-eslint/base" with a parser.',
    );
  }
  return defineConfig({
    files: ['**/*.{ts,tsx,mjs,js}'],
    plugins: { zukhruf },
    languageOptions: { parser },
    rules: { 'zukhruf/no-node-env': 'error' },
  });
}

/**
 * The messages of zukhruf/no-node-env, the one rule on, for each .ts, .tsx,
 * .mjs and .js file that the generator created or changed in `tree`:
 * `<path>:<line>:<column> <rule> <message>`.
 */
export async function lintNodeEnv(tree: Tree): Promise<string[]> {
  const eslint = new ESLint({
    cwd: CWD,
    overrideConfigFile: true,
    overrideConfig: config(),
  });
  const messages: string[] = [];
  for (const [path, content] of changes(tree)) {
    if (content === undefined || !SOURCE.test(path)) continue;
    const [result] = await eslint.lintText(content, {
      filePath: resolve(CWD, path),
    });
    for (const message of result?.messages ?? []) {
      messages.push(
        `${path}:${message.line}:${message.column} ${message.ruleId} ${message.message}`,
      );
    }
  }
  return messages;
}
