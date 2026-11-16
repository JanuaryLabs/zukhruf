import { readFile } from 'node:fs/promises';

import { Lockfile } from '../npm/lockfile.ts';

// Whether the installed packages differ from the lockfile of a commit. npm's
// hidden lockfile, node_modules/.package-lock.json, lists what is installed.
// Each difference in the third-party packages is drift: a missing package, a
// different version, or an extra package, which would build here and fail in
// CI. Links are not compared: a workspace link points into the snapshot.
export async function hasInstallDrift(
  lockfile: string,
  hiddenLockfile: string,
): Promise<boolean> {
  const wanted = Lockfile.parse(await readFile(lockfile, 'utf8')).thirdParty();
  let hidden: string;
  try {
    hidden = await readFile(hiddenLockfile, 'utf8');
  } catch (error) {
    if (Error.isError(error) && 'code' in error && error.code === 'ENOENT')
      return true;
    throw error;
  }
  const installed = Lockfile.parse(hidden).thirdParty();
  for (const [path, entry] of wanted) {
    const have = installed.get(path);
    if (have === undefined) {
      // npm skips an optional package that does not fit the platform.
      if (!entry.optional) return true;
    } else if (have.version !== entry.version) return true;
  }
  for (const path of installed.keys()) if (!wanted.has(path)) return true;
  return false;
}
