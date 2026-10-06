import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRecord } from '../authoring/ast.ts';

const eslintBin = join(
  dirname(fileURLToPath(import.meta.resolve('eslint/package.json'))),
  'bin',
  'eslint.js',
);

export interface Finding {
  readonly file: string;
  readonly ruleId: string | null;
  readonly message: string;
}

function eslint(cwd: string, args: string[]): string {
  const run = spawnSync(process.execPath, [eslintBin, ...args], {
    cwd,
    encoding: 'utf8',
  });
  // 0: clean, 1: findings, 2: ESLint itself failed (bad config, crash).
  if (run.status !== 0 && run.status !== 1) {
    throw new Error(`eslint ${args.join(' ')} failed:\n${run.stderr}`);
  }
  return run.stdout;
}

/**
 * Runs the real ESLint CLI in its own process from `cwd`, the way `nx lint`
 * runs it from a project folder, and returns every finding.
 */
export function lint(cwd: string, paths: string[]): Finding[] {
  const results: unknown = JSON.parse(
    eslint(cwd, ['--format', 'json', ...paths]),
  );
  if (!Array.isArray(results)) throw new Error('ESLint printed no results.');
  return results.flatMap((result: unknown) => {
    if (!isRecord(result) || !Array.isArray(result['messages'])) return [];
    const file = String(result['filePath']);
    return result['messages'].filter(isRecord).map((message) => ({
      file,
      ruleId: typeof message['ruleId'] === 'string' ? message['ruleId'] : null,
      message: String(message['message']),
    }));
  });
}

/** The config ESLint computes for `file`, run from `cwd`. */
export function printConfig(cwd: string, file: string): unknown {
  return JSON.parse(eslint(cwd, ['--print-config', file]));
}

/**
 * The text of an eslint.config.mjs for a fixture workspace outside this repo:
 * every import is an absolute URL resolved from here, and the package is
 * imported by name, so the build that consumers install (`dist`) is the one
 * under test.
 */
export function fixtureConfig(body: string): string {
  const url = (specifier: string) =>
    JSON.stringify(import.meta.resolve(specifier));
  return [
    `import { defineConfig } from ${url('eslint/config')};`,
    `import zukhruf from ${url('@zukhruf/eslint')};`,
    `import island from ${url('@zukhruf/eslint/nx')};`,
    `export default defineConfig(${body});`,
  ].join('\n');
}
