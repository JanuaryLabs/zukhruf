import { execFile } from 'node:child_process';
import { hash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';

import { FileLock } from '@zukhruf/fs';

import { Lockfile } from '../npm/lockfile.ts';
import { workspaceFolders } from './workspaces.ts';

const execFileAsync = promisify(execFile);

// The installs that the hook keeps: the ones that it used last.
const kept = 2;
// Written last, so a folder without it is an install that did not end.
const marker = 'installed';
// One locked file in it for each snapshot that links to the install.
const leases = 'leases';

// Marks the install at `folder` as in use until the lease is disposed. The
// kernel holds the lock of the lease file, so a hook that dies lets it go.
// Take it under the lock of the installs, so no prune runs between the
// install and the lease.
export function leaseInstall(folder: string): Disposable {
  mkdirSync(join(folder, leases), { recursive: true });
  const path = join(folder, leases, `${randomUUID()}.lock`);
  const lease = new DisposableStack();
  const lock = lease.use(FileLock.open(path));
  if (!lock.tryLock())
    throw new Error(`another process holds the new lease ${path}`);
  lease.defer(() => rmSync(path, { force: true }));
  return lease;
}

// An install of the lockfile of the snapshot in a folder of the state folder,
// named by the hash of the lockfile and the .npmrc. A second snapshot with the
// same two files uses the same install, with the linked folders of the
// snapshot. `installing` runs before a new install, because a full install
// takes some time. npm gets `environment`: the tool environment.
export async function installFor(
  state: string,
  snapshot: string,
  environment: NodeJS.ProcessEnv,
  installing: () => void,
  clock: { readonly Date: { now(): number } },
): Promise<string> {
  const installs = join(state, 'installs');
  const folder = join(installs, (await installKey(snapshot)).slice(0, 16));
  if (existsSync(join(folder, marker))) {
    const now = new Date(clock.Date.now());
    await utimes(join(folder, marker), now, now);
    await copyLinkedFolders(snapshot, folder);
  } else {
    installing();
    await rm(folder, { recursive: true, force: true });
    await install(snapshot, folder, environment);
  }
  await prune(installs);
  return folder;
}

// The sha256 of the lockfile and the .npmrc, with a NUL between them: a
// lockfile is JSON, which holds no NUL, so no two pairs of files give the
// same bytes. A snapshot without .npmrc hashes it as empty.
async function installKey(snapshot: string): Promise<string> {
  const lockfile = await readFile(join(snapshot, 'package-lock.json'));
  let npmrc: Buffer;
  try {
    npmrc = await readFile(join(snapshot, '.npmrc'));
  } catch (error) {
    if (!Error.isError(error) || !('code' in error) || error.code !== 'ENOENT')
      throw error;
    npmrc = Buffer.alloc(0);
  }
  return hash('sha256', Buffer.concat([lockfile, Buffer.from([0]), npmrc]));
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
  // The full tree of the commit, as a clean checkout has it: each file that
  // npm reads, such as the patch files of `patchedDependencies`, a
  // `.npm-extension.mjs`, the workspace manifests and the folders of `file:`
  // dependencies. A link keeps its text, so it points into the install.
  await cp(snapshot, folder, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !['.git', 'node_modules'].includes(basename(source)),
  });
  await npm(
    folder,
    environment,
    'ci',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  );
  const names = Lockfile.parse(
    await readFile(join(folder, 'package-lock.json'), 'utf8'),
  ).withInstallScripts();
  if (names.length > 0) await npm(folder, environment, 'rebuild', ...names);
  await writeFile(join(folder, marker), '');
}

// Copies each folder of the snapshot that a `file:` dependency links to into
// the install that the snapshot uses again. A package of the install that
// depends on it resolves it from its real path in the install, so a link from
// the snapshot does not reach it. The lockfile, which names the install, does
// not change when the files of the folder change, so each snapshot copies the
// folder again. The copy keeps the node_modules that npm installed in the
// folder. A folder in node_modules is npm's, a folder outside the repo is not
// in the snapshot, and a workspace package links to its folder in the
// snapshot: none of them is copied. A folder that the lockfile names and the
// commit does not have, such as a workspace that .gitignore names, is not
// copied either (#4193).
async function copyLinkedFolders(
  snapshot: string,
  folder: string,
): Promise<void> {
  const workspaces = new Set((await workspaceFolders(snapshot)).map(normalize));
  const lockfile = Lockfile.parse(
    await readFile(join(snapshot, 'package-lock.json'), 'utf8'),
  );
  for (const target of lockfile.linkTargets()) {
    const path = normalize(target);
    if (
      workspaces.has(path) ||
      path.startsWith('..') ||
      isAbsolute(path) ||
      path.split(sep).includes('node_modules')
    )
      continue;
    // The copy first empties the folder of the install, so the source is
    // checked before.
    if (!existsSync(join(snapshot, path))) continue;
    const destination = join(folder, path);
    await mkdir(destination, { recursive: true });
    for (const name of await readdir(destination))
      if (name !== 'node_modules')
        await rm(join(destination, name), { recursive: true, force: true });
    await cp(join(snapshot, path), destination, {
      recursive: true,
      filter: (source) => basename(source) !== 'node_modules',
    });
  }
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
    if (!Error.isError(error) || !('stderr' in error)) throw error;
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
    if ((index >= kept || at < 0) && !(await isLeased(join(installs, name))))
      await rm(join(installs, name), { recursive: true, force: true });
}

// Whether a live snapshot links to the install. Only an install that the
// prune would delete is checked: the install that this process uses is the
// one it used last, which the prune keeps. That matters, because reading a
// lease file that this process holds would drop its lock (FileLock).
async function isLeased(folder: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(join(folder, leases));
  } catch (error) {
    if (Error.isError(error) && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
  return names.some(
    (name) => FileLock.check(join(folder, leases, name)) === 'locked',
  );
}
