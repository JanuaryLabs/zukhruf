import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { DockerHost, SHELL_TIMEOUT, quote } from '../docker/host.ts';
import { directoryPrefix, forwardPrefix } from '../docker/run-records.ts';

/** What the global setup writes to run.json. */
export interface Run {
  id: string;
  endpoint: string;
  pid: number;
}

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
      if (
        !path.startsWith(forwardPrefix(run.id)) ||
        path.slice(5).includes('/')
      )
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
