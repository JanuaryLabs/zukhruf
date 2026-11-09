// The default export is the module object itself, which mock.method can patch;
// syncBuiltinESMExports then copies the patch to the named exports.
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { sep } from 'node:path';
import type { TestContext } from 'node:test';

/** The `f_type` that Linux's statfs reports for each network file system, from the kernel's and Lustre's headers. */
export const networkFileSystems = [
  ['NFS', 0x6969n],
  ['SMB', 0x517bn],
  ['CIFS', 0xff534d42n],
  ['SMB2', 0xfe534d42n],
  ['Ceph', 0x00c36400n],
  ['AFS', 0x5346414fn],
  ['kAFS', 0x6b414653n],
  ['Coda', 0x73757245n],
  ['NCP', 0x564cn],
  ['OCFS2', 0x7461636fn],
  ['GFS2', 0x01161970n],
  ['Lustre', 0x0bd00bd0n],
  ['9p', 0x01021997n],
] as const;

/** Whether `path` is `directory` itself or lies inside it. */
export const within = (directory: string, path: string) =>
  path === directory || path.startsWith(directory + sep);

/**
 * Makes statfs report `type` for `directory` and everything inside it, as a
 * mount of that file system would. Every other path gets the real answer.
 */
export function mountAs(t: TestContext, directory: string, type: bigint) {
  const statfs = fsPromises.statfs;
  t.mock.method(
    fsPromises,
    'statfs',
    async (...args: Parameters<typeof fsPromises.statfs>) => {
      const stats = await statfs(...args);
      return within(directory, String(args[0]))
        ? Object.assign(stats, { type })
        : stats;
    },
  );
  syncBuiltinESMExports();
  return {
    [Symbol.dispose]() {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}

export const onLinux = {
  skip:
    process.platform === 'linux'
      ? false
      : 'Only Linux statfs reports a stable file system type',
};
