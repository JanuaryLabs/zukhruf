import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command, ExitError } from '@zukhruf/process';

import { isRecord } from '../unknown-values.ts';

const eslintBin = join(
  dirname(fileURLToPath(import.meta.resolve('eslint/package.json'))),
  'bin',
  'eslint.js',
);

export interface Finding {
  readonly file: string;
  readonly ruleId: string | null;
  readonly message: string;
  readonly line: number;
}

/**
 * Runs the ESLint CLI in its own process without holding the event loop, so
 * the tests of a file can run at the same time.
 */
async function eslint(
  cwd: string,
  args: string[],
  nodeArgs: readonly string[] = [],
): Promise<string> {
  const run = await new Command(
    process.execPath,
    [...nodeArgs, eslintBin, ...args],
    { env: process.env, clock: globalThis, cwd, name: 'eslint' },
  ).run();
  // 0: clean, 1: findings, 2: ESLint itself failed (bad config, crash).
  if (run.exitCode !== 0 && run.exitCode !== 1)
    throw new ExitError('eslint', run);
  return run.stdout;
}

/**
 * Runs the real ESLint CLI in its own process from `cwd`, the way `nx lint`
 * runs it from a project folder, and returns every finding. `nodeArgs` go to
 * Node before the CLI, such as an `--import` of module hooks.
 */
export async function lint(
  cwd: string,
  paths: string[],
  nodeArgs: readonly string[] = [],
): Promise<Finding[]> {
  const results: unknown = JSON.parse(
    await eslint(cwd, ['--format', 'json', ...paths], nodeArgs),
  );
  if (!Array.isArray(results)) throw new Error('ESLint printed no results.');
  return results.flatMap((result: unknown) => {
    if (!isRecord(result) || !Array.isArray(result['messages'])) return [];
    const file = String(result['filePath']);
    return result['messages'].filter(isRecord).map((message) => ({
      file,
      ruleId: typeof message['ruleId'] === 'string' ? message['ruleId'] : null,
      message: String(message['message']),
      line: Number(message['line']),
    }));
  });
}

/**
 * The source of `file` after ESLint applies its fixes, run from `cwd` as
 * `lint` runs: `--fix-dry-run` prints the fixed source and writes nothing.
 * The source as it is when no fix applies.
 */
export async function fixed(cwd: string, file: string): Promise<string> {
  const results: unknown = JSON.parse(
    await eslint(cwd, ['--fix-dry-run', '--format', 'json', file]),
  );
  if (!Array.isArray(results) || !isRecord(results[0]))
    throw new Error('ESLint printed no result.');
  const { output, source } = results[0];
  if (typeof output === 'string') return output;
  if (typeof source === 'string') return source;
  throw new Error(
    `ESLint printed neither the output nor the source of ${file}.`,
  );
}

/** The config ESLint computes for `file`, run from `cwd`. */
export async function printConfig(cwd: string, file: string): Promise<unknown> {
  return JSON.parse(await eslint(cwd, ['--print-config', file]));
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
    `import island, { manifest } from ${url('@zukhruf/eslint/nx')};`,
    `import hermes from ${url('@zukhruf/eslint/react-native')};`,
    `export default defineConfig(${body});`,
  ].join('\n');
}
