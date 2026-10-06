import { statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { isErrno } from '../shared/fs/errno.ts';
import { NetworkDirectoryError } from './network-directory-error.ts';

/**
 * The `f_type` Linux's statfs reports for each network file system: from the
 * kernel's uapi/linux/magic.h, gfs2_ondisk.h (GFS2) and Lustre's lustre_user.h.
 * FUSE is left out on purpose: on one kernel, its mounts hold the stores' locks.
 */
const linuxNetworkFileSystems = new Map<bigint, string>([
  [0x6969n, 'NFS'],
  [0x517bn, 'SMB'],
  [0xff534d42n, 'CIFS'],
  [0xfe534d42n, 'SMB2'],
  [0x00c36400n, 'Ceph'],
  [0x5346414fn, 'AFS'],
  [0x6b414653n, 'kAFS'],
  [0x73757245n, 'Coda'],
  [0x564cn, 'NCP'],
  [0x7461636fn, 'OCFS2'],
  [0x01161970n, 'GFS2'],
  [0x0bd00bd0n, 'Lustre'],
  [0x01021997n, '9p'],
]);

/** What a platform can tell about a directory's file system. */
type Judgement =
  | { kind: 'local' }
  | { kind: 'network'; fileSystem: string }
  /** The check itself failed, so nothing is known: the lock goes ahead as it did before the check existed. */
  | { kind: 'unknown' };

const local: Judgement = { kind: 'local' };
const unknown: Judgement = { kind: 'unknown' };

/**
 * How each platform judges a directory. Only Linux reports a stable file
 * system type; macOS numbers its file systems as they load, so it has no
 * judge, and every directory counts as local there.
 */
const judges: Partial<
  Record<NodeJS.Platform, (path: string) => Promise<Judgement>>
> = {
  linux: (path) =>
    statfsOfNearest(path).then(
      ({ type }) => {
        // f_type is a signed long, so a magic with its high bit set can arrive sign-extended.
        const fileSystem = linuxNetworkFileSystems.get(
          BigInt.asUintN(32, type),
        );
        return fileSystem ? { kind: 'network', fileSystem } : local;
      },
      () => unknown,
    ),
  win32: async (path) =>
    isUncPath(path) ? { kind: 'network', fileSystem: 'UNC share' } : local,
};

/** A directory's file system does not change under a running process, so each local one is judged once. */
const localDirectories = new Set<string>();

/**
 * Rejects with `NetworkDirectoryError` when `directory` is on a network file
 * system, where the stores' locks are not shared reliably between machines.
 * A directory that does not exist yet is judged by its nearest existing parent.
 */
export async function assertLocalDirectory(directory: string): Promise<void> {
  const path = resolve(directory);
  if (localDirectories.has(path)) return;
  const judgement = (await judges[process.platform]?.(path)) ?? local;
  if (judgement.kind === 'network') {
    throw new NetworkDirectoryError(directory, judgement.fileSystem);
  }
  if (judgement.kind === 'local') localDirectories.add(path);
}

async function statfsOfNearest(path: string) {
  try {
    return await statfs(path, { bigint: true });
  } catch (error) {
    const parent = dirname(path);
    if (!isErrno(error, 'ENOENT') || parent === path) throw error;
    return statfsOfNearest(parent);
  }
}

/** `\\server\share`, `\\?\UNC\server\share` and `\\.\UNC\server\share`; `\\?\C:\` names a local drive. */
function isUncPath(path: string): boolean {
  if (/^\\\\[?.]\\/.test(path)) return /^\\\\[?.]\\UNC\\/i.test(path);
  return path.startsWith('\\\\');
}
