import { readFile } from 'node:fs/promises';

interface LockEntry {
  readonly version: unknown;
  readonly link: boolean;
  readonly optional: boolean;
  readonly hasInstallScript: boolean;
}

// Whether the installed packages differ from the lockfile of a commit. npm's
// hidden lockfile, node_modules/.package-lock.json, lists what is installed.
// Each difference in the third-party packages is drift: a missing package, a
// different version, or an extra package, which would build here and fail in
// CI. Links are not compared: a workspace link points into the snapshot.
export async function hasInstallDrift(
  lockfile: string,
  hiddenLockfile: string,
): Promise<boolean> {
  const wanted = await packagesOf(lockfile);
  let installed: Map<string, LockEntry>;
  try {
    installed = await packagesOf(hiddenLockfile);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return true;
    throw error;
  }
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

// The third-party packages of a lockfile: the entries in a node_modules
// folder that are not links.
async function packagesOf(path: string): Promise<Map<string, LockEntry>> {
  const lockfile: unknown = JSON.parse(await readFile(path, 'utf8'));
  const packages =
    typeof lockfile === 'object' && lockfile !== null && 'packages' in lockfile
      ? lockfile.packages
      : undefined;
  if (typeof packages !== 'object' || packages === null)
    throw new TypeError(`${path} has no "packages"; npm 7 or later writes it`);
  const entries = new Map<string, LockEntry>();
  for (const [key, value] of Object.entries(packages)) {
    if (!key.includes('node_modules/')) continue;
    const entry = {
      version: field(value, 'version'),
      link: field(value, 'link') === true,
      optional: field(value, 'optional') === true,
      hasInstallScript: field(value, 'hasInstallScript') === true,
    };
    if (!entry.link) entries.set(key, entry);
  }
  return entries;
}

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value
    ? Reflect.get(value, name)
    : undefined;
}

// The third-party packages that the lockfile marks with an install script.
// The root and the workspace packages have the mark too, but their scripts
// must not run in the state folder.
export async function withInstallScripts(lockfile: string): Promise<string[]> {
  const names = new Set<string>();
  for (const [key, entry] of await packagesOf(lockfile))
    if (entry.hasInstallScript)
      names.add(
        key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length),
      );
  return [...names];
}
