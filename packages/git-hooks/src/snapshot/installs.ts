import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { withInstallScripts } from './drift.ts';
import { workspaceFolders } from './workspaces.ts';

const execFileAsync = promisify(execFile);

// The installs that the hook keeps: the ones that it used last.
const kept = 2;
// Written last, so a folder without it is an install that did not end.
const marker = 'installed';

// An install of the lockfile of the snapshot in a folder of the state folder,
// named by the hash of the lockfile. A second push with the same lockfile
// uses the same install. `installing` runs before a new install, because a
// full install takes some time.
export async function installFor(
  state: string,
  snapshot: string,
  environment: NodeJS.ProcessEnv,
  installing: () => void,
): Promise<string> {
  const lockfile = await readFile(join(snapshot, 'package-lock.json'));
  const hash = createHash('sha256').update(lockfile).digest('hex');
  const installs = join(state, 'installs');
  const folder = join(installs, hash.slice(0, 16));
  if (existsSync(join(folder, marker))) {
    const now = new Date();
    await utimes(join(folder, marker), now, now);
  } else {
    installing();
    await rm(folder, { recursive: true, force: true });
    await install(snapshot, folder, environment);
  }
  await prune(installs);
  return folder;
}

// `npm ci --ignore-scripts`, and then `npm rebuild` with only the
// third-party packages that have install scripts, such as esbuild. The
// scripts of the repo and of its workspace packages, such as `prepare`,
// would act on the repo from the state folder, so they do not run. Without
// names, `npm rebuild` runs them too. npm 12 runs only the dependency
// scripts that `allowScripts` in the copied package.json approves.
async function install(
  snapshot: string,
  folder: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await mkdir(folder, { recursive: true });
  for (const file of ['package.json', 'package-lock.json', '.npmrc'])
    if (existsSync(join(snapshot, file)))
      await copyFile(join(snapshot, file), join(folder, file));
  for (const workspace of await workspaceFolders(snapshot)) {
    await mkdir(join(folder, workspace), { recursive: true });
    await copyFile(
      join(snapshot, workspace, 'package.json'),
      join(folder, workspace, 'package.json'),
    );
  }
  await npm(
    folder,
    environment,
    'ci',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  );
  const names = await withInstallScripts(join(folder, 'package-lock.json'));
  if (names.length > 0) await npm(folder, environment, 'rebuild', ...names);
  await writeFile(join(folder, marker), '');
}

async function npm(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<void> {
  try {
    await execFileAsync('npm', args, {
      cwd,
      env: environment,
      encoding: 'utf8',
      maxBuffer: 2 ** 30,
      // npm is a .cmd file on Windows, which only a shell runs. The
      // arguments are npm's own flags and package names, which need no quotes.
      shell: process.platform === 'win32',
    });
  } catch (error) {
    if (!(error instanceof Error) || !('stderr' in error)) throw error;
    throw new Error(
      `npm ${args.join(' ')} failed:\n${String(error.stderr).trimEnd()}`,
      { cause: error },
    );
  }
}

async function prune(installs: string): Promise<void> {
  const used = await Promise.all(
    (await readdir(installs)).map(async (name) => ({
      name,
      at: await stat(join(installs, name, marker)).then(
        ({ mtimeMs }) => mtimeMs,
        () => -1,
      ),
    })),
  );
  used.sort((left, right) => right.at - left.at);
  for (const [index, { name, at }] of used.entries())
    if (index >= kept || at < 0)
      await rm(join(installs, name), { recursive: true, force: true });
}
