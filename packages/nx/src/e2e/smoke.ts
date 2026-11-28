// The nightly smoke test of @zukhruf/nx (packages/nx ADR 0020): a workspace
// of the standard from a published version, committed through its hooks, then
// checked as a fresh checkout in CI checks it. The `e2e:smoke` target runs it;
// `--version <v>` checks another published version than `latest`.
import { rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { TemporaryFiles, isErrno } from '@zukhruf/fs';

import {
  StepFailed,
  dbProject,
  generateWorkspace,
  latestVersion,
  read,
  step,
} from './generated-workspace.ts';

const { values } = parseArgs({ options: { version: { type: 'string' } } });

await using folder = await new TemporaryFiles().directory('zukhruf-nx-smoke-');
const version = values.version ?? (await latestVersion(folder.path));
try {
  const root = await generateWorkspace(folder.path, version);
  // The auth generator writes the models of better-auth and no migration; the
  // README says to write the first migration then (migrate:check fails until
  // the migrations build the schema).
  await step(
    'Write the first migration',
    'npx',
    ['nx', 'run', `${dbProject}:migrate:create`, '--name', 'auth'],
    root,
  );
  await step('Stage every file', 'git', ['add', '--', '.'], root);
  await step(
    'Commit through the hooks of the workspace',
    'git',
    ['commit', '--message', 'chore: the generated workspace', '--', '.'],
    root,
  );
  // A fresh checkout: no generated client, no dist, no .nx. The installed
  // packages stay, as `npm ci` gives them to a CI job. The pathspec keeps Git
  // out of each node_modules, where the `dist` rule of .gitignore matches the
  // built files of the packages.
  console.log('\n==> Remove what Git ignores, except node_modules');
  const ignored = await read(
    'git',
    [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--',
      '.',
      ':(exclude,glob)**/node_modules/**',
    ],
    root,
  );
  for (const file of ignored.split('\n').filter((line) => line !== '')) {
    console.log(`    ${file}`);
    await rm(join(root, file));
    await removeEmptyFolders(root, dirname(file));
  }
  await step(
    'Lint, type check, build and test every project',
    'npx',
    [
      'nx',
      'run-many',
      '-t',
      'lint',
      'typecheck',
      'build',
      'test',
      '--skip-nx-cache',
    ],
    root,
  );
  console.log(`\nThe smoke test of @zukhruf/nx@${version} passed.`);
} catch (error) {
  if (!(error instanceof StepFailed)) throw error;
  console.error(
    `\nThe smoke test of @zukhruf/nx@${version} failed at a step. ${error.message}`,
  );
  process.exitCode = 1;
}

/**
 * Removes `folder` and each parent that its removed files left empty, as a
 * fresh checkout has no such folder: Prisma refuses an output folder that
 * holds anything but a client, empty folders included. The walk stops at the
 * first folder that still holds a file.
 */
async function removeEmptyFolders(root: string, folder: string) {
  for (let current = folder; current !== '.'; current = dirname(current)) {
    try {
      await rmdir(join(root, current));
    } catch (error) {
      if (isErrno(error, 'ENOTEMPTY')) return;
      throw error;
    }
  }
}
