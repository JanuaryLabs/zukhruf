// The freshness check that the `show` target of `@zukhruf/nx/opentofu` runs
// in an environment folder: `node check-plan-fresh.js <project root>`. It
// stops when the environment has no `tfplan`, or when a file of the project
// changed after `preview` wrote the plan. A file of the project is one that
// Git tracks or does not ignore, so `.terraform`, `.env` and the other plans
// do not count.
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { Command, ExitError } from '@zukhruf/process';

const [projectRoot = '.'] = process.argv.slice(2);

async function modified(path: string) {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if (Error.isError(error) && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

const planned = await modified('tfplan');
if (planned === undefined) {
  console.error(
    `${process.cwd()} has no tfplan. Run the preview target of this project first.`,
  );
  process.exit(1);
}

// Paths come back relative to the working folder, so each one can be read
// from here.
const listed = await new Command(
  'git',
  [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    projectRoot,
  ],
  { env: process.env, clock: globalThis },
).run();
if (listed.exitCode !== 0) throw new ExitError('git ls-files', listed);
const files = listed.stdout
  .split('\0')
  .filter((file) => file !== '' && basename(file) !== 'tfplan');

for (const file of new Set(files)) {
  const changed = await modified(file);
  if (changed === undefined || changed > planned) {
    console.error(
      `tfplan is stale: ${file} ${changed === undefined ? 'was deleted' : 'changed'} after preview wrote the plan. Run preview again, then show.`,
    );
    process.exit(1);
  }
}
