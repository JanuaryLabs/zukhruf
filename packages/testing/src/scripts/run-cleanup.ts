import { readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { isErrno } from '@zukhruf/fs';

import { forwardName } from '../docker/run-records.ts';

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
 * Removes the SSH forward directories that the run's records name, and then
 * each record. The reaper of the run removes its engine objects (ADR 0020,
 * item 6) and its host directories (ADR 0023). Synchronous, so the global
 * teardown finishes under `--test-force-exit`.
 */
export function removeRecordedPaths(run: Run, directory: string): void {
  for (const file of readdirSync(directory)) {
    if (!file.startsWith('forward-')) continue;
    const record = join(directory, file);
    const path = recordedPath(record);
    if (!isForwardDirectory(path, run.id))
      throw new Error(`Invalid SSH forwarding cleanup record: ${path}`);
    rmSync(path, { recursive: true, force: true });
    rmSync(record, { force: true });
  }
}
