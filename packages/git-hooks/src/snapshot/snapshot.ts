import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';

import type { Clone } from './snapshots.ts';

// What a command gave: its exit code, or null when a signal ended it, and its
// output. The field names are those of Node's `spawnSync`.
export interface ProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

// More environment variables for one command, over the tool environment.
export interface RunOptions {
  readonly env?: Readonly<Record<string, string>>;
}

// A commit checked out in a temporary folder, where a step runs its tools.
// Git there sees a clean checkout of the commit. Each command gets the tool
// environment, with NX_DAEMON=false and the nx cache of the state folder.
export class Snapshot {
  readonly folder: string;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(clone: Clone) {
    this.folder = clone.folder;
    this.#environment = clone.environment;
  }

  // Runs a command from the PATH, or a file at an absolute path, in the
  // snapshot. An exit code other than 0 is a result, not an error. A command
  // that cannot start throws the error of Node. No shell runs, except for a
  // .cmd file on Windows, which only a shell runs; its arguments then get no
  // quotes.
  async run(
    command: string,
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<ProcessResult> {
    const child = spawn(command, args, {
      cwd: this.folder,
      env: { ...this.#environment, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && command.endsWith('.cmd'),
    });
    const [stdout, stderr, status] = await Promise.all([
      text(child.stdout),
      text(child.stderr),
      new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      }),
    ]);
    return { status, stdout, stderr };
  }
}

// A snapshot with a node_modules: the packages of the commit's own lockfile,
// and each workspace package from its folder in the snapshot.
export class PackagedSnapshot extends Snapshot {
  // The nx cache of the state folder, where nx writes the summary of its run.
  readonly nxCacheDirectory: string;

  constructor(clone: Clone) {
    super(clone);
    this.nxCacheDirectory = clone.nxCacheDirectory;
  }

  // Runs `node_modules/.bin/<name>` of the snapshot, as `run` does. On
  // Windows, npm writes `<name>.cmd` there.
  bin(
    name: string,
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<ProcessResult> {
    return this.run(
      join(
        this.folder,
        'node_modules/.bin',
        process.platform === 'win32' ? `${name}.cmd` : name,
      ),
      args,
      options,
    );
  }
}
