import { execFile } from 'node:child_process';
import { join } from 'node:path';

export interface NxRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

// Runs the nx of the snapshot's node_modules in the snapshot. On Windows,
// npm writes `.bin/nx.cmd`, which only a shell runs.
export function runNx(
  folder: string,
  environment: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<NxRun> {
  const windows = process.platform === 'win32';
  return new Promise((resolve) => {
    execFile(
      join(folder, 'node_modules/.bin', windows ? 'nx.cmd' : 'nx'),
      args,
      {
        cwd: folder,
        env: environment,
        encoding: 'utf8',
        maxBuffer: 2 ** 30,
        shell: windows,
      },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}
