import { existsSync } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  stat,
  symlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { workspaceFolders } from './workspaces.ts';

// Gives the snapshot a node_modules made from the install at `installRoot`
// (the repo, or an install in the state folder). Each node_modules folder is
// a real folder, so a tool that writes into node_modules (vite writes
// .vite-temp) writes into the snapshot. A workspace link points to the same
// path in the snapshot. Each other entry links to the installed entry, with
// an absolute path: a junction on Windows, which needs no administrator
// rights. Other dot entries are tool state, and are left out.
export async function linkPackages(
  installRoot: string,
  snapshot: string,
): Promise<void> {
  const root = await realpath(installRoot);
  if (!existsSync(join(root, 'node_modules'))) return;
  // A link is read from where it really is: node_modules can be a link too.
  const installed = await realpath(join(root, 'node_modules'));
  await mirror(root, installed, join(snapshot, 'node_modules'), snapshot);
  for (const folder of await workspaceFolders(snapshot)) {
    const nested = join(root, folder, 'node_modules');
    if (existsSync(nested))
      await mirror(
        root,
        await realpath(nested),
        join(snapshot, folder, 'node_modules'),
        snapshot,
      );
  }
}

async function mirror(
  root: string,
  source: string,
  destination: string,
  snapshot: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(source)) {
    const entry = join(source, name);
    if (name === '.bin') await copyBin(entry, join(destination, name));
    else if (name.startsWith('.')) continue;
    else if (name.startsWith('@') && (await lstat(entry)).isDirectory()) {
      await mkdir(join(destination, name));
      for (const scoped of await readdir(entry))
        await link(
          root,
          join(entry, scoped),
          join(destination, name, scoped),
          snapshot,
        );
    } else await link(root, entry, join(destination, name), snapshot);
  }
}

async function link(
  root: string,
  entry: string,
  destination: string,
  snapshot: string,
): Promise<void> {
  const stats = await lstat(entry);
  if (stats.isSymbolicLink()) {
    // A workspace link points into the repo, outside node_modules. It can
    // point to a folder that a build writes later, so it is read as text.
    const target = resolve(dirname(entry), await readlink(entry));
    const inTree = relative(root, target);
    if (
      !inTree.startsWith('..') &&
      !isAbsolute(inTree) &&
      !inTree.split(sep).includes('node_modules')
    )
      return symlink(join(snapshot, inTree), destination, 'junction');
  }
  const isFolder = await stat(entry).then(
    (target) => target.isDirectory(),
    () => true,
  );
  if (isFolder) return symlink(entry, destination, 'junction');
  return copyFile(entry, destination);
}

// A link in .bin keeps its relative text, so `../pkg/bin/x` resolves through
// the snapshot's node_modules, and a workspace bin runs from the snapshot. A
// file, such as a Windows .cmd shim, is copied.
async function copyBin(source: string, destination: string): Promise<void> {
  await mkdir(destination);
  for (const name of await readdir(source)) {
    const entry = join(source, name);
    if ((await lstat(entry)).isSymbolicLink())
      await symlink(await readlink(entry), join(destination, name));
    else await copyFile(entry, join(destination, name));
  }
}
