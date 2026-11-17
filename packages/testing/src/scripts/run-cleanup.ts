import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { isErrno } from '@zukhruf/fs';

import { DockerHost, SHELL_TIMEOUT, quote } from '../docker/host.ts';
import { directoryPrefix, forwardName } from '../docker/run-records.ts';

/** What the global setup writes to run.json. */
export interface Run {
  id: string;
  endpoint: string;
  pid: number;
}

// A forward directory is a direct child of /tmp whose name starts with the
// run's prefix. The real path of its parent decides, so `..` cannot lead out,
// and a record that names /tmp as written still matches. A parent that is
// gone is no parent of a forward directory.
const isForwardDirectory = (path: string, id: string): boolean => {
  if (!basename(path).startsWith(forwardName(id))) return false;
  try {
    return realpathSync(dirname(path)) === realpathSync('/tmp');
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return false;
    throw error;
  }
};

const recordedPath = (file: string): string => {
  const { path }: { path: string } = JSON.parse(readFileSync(file, 'utf8'));
  return path;
};

/**
 * Removes the paths that the run's records name, and then each record: the
 * SSH forward directories and the host directories. The reaper of the run
 * removes its engine objects (ADR 0020, item 6). Synchronous, so the global
 * teardown finishes under `--test-force-exit`.
 */
export function removeRecordedPaths(run: Run, directory: string): void {
  const host = new DockerHost(run.endpoint, undefined);
  for (const file of readdirSync(directory)) {
    const record = join(directory, file);
    if (file.startsWith('forward-')) {
      const path = recordedPath(record);
      if (!isForwardDirectory(path, run.id))
        throw new Error(`Invalid SSH forwarding cleanup record: ${path}`);
      rmSync(path, { recursive: true, force: true });
    } else if (file.startsWith('directory-')) {
      const path = recordedPath(record);
      if (
        !path.includes(`/${directoryPrefix(run.id)}`) ||
        path.includes('/../')
      )
        throw new Error(`Invalid fixture cleanup record: ${path}`);
      if (host.remote)
        execFileSync('ssh', [...host.sshArgs(), `rm -rf -- ${quote(path)}`], {
          timeout: SHELL_TIMEOUT,
          stdio: 'ignore',
        });
      else rmSync(path, { recursive: true, force: true });
    } else continue;
    rmSync(record, { force: true });
  }
}
