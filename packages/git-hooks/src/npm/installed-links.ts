import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { isErrno } from '@zukhruf/fs';

import { workspaceFolders } from '../snapshot/workspaces.ts';

// An installed package that is a link to a folder outside the repo.
export interface InstalledOutsideLink {
  // Its folder, relative to the repo, such as `node_modules/@x/y`.
  readonly folder: string;
  readonly name: string;
  // The real path of the folder that the link points to.
  readonly target: string;
}

// The packages in `node_modules` of the repo at `repo`, a real path, and in
// `node_modules` of each of its workspaces, that are links whose real path is
// outside the repo. A workspace link points inside the repo.
export async function installedOutsideLinks(
  repo: string,
): Promise<InstalledOutsideLink[]> {
  const links: InstalledOutsideLink[] = [];
  for (const folder of [
    'node_modules',
    ...(await workspaceFolders(repo)).map((workspace) =>
      join(workspace, 'node_modules'),
    ),
  ]) {
    for (const name of await packageNames(join(repo, folder))) {
      const entry = join(repo, folder, name);
      if (!(await lstat(entry)).isSymbolicLink()) continue;
      const target = await linkTarget(entry);
      const inRepo = relative(repo, target);
      if (inRepo.startsWith('..') || isAbsolute(inRepo))
        links.push({ folder: join(folder, name), name, target });
    }
  }
  return links;
}

// The package names of a node_modules folder: `x` and `@scope/x`. Dot
// entries, such as `.bin`, are not packages. A workspace without its own
// node_modules has none.
async function packageNames(folder: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(folder);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  }
  const names: string[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@') && (await lstat(join(folder, name))).isDirectory())
      for (const scoped of await readdir(join(folder, name)))
        names.push(`${name}/${scoped}`);
    else names.push(name);
  }
  return names;
}

// The real path of the folder that a link points to. A link to a folder that
// does not exist has no real path, so its text names the folder.
async function linkTarget(link: string): Promise<string> {
  try {
    return await realpath(link);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
    return resolve(dirname(link), await readlink(link));
  }
}
