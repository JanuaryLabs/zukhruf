import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtempDisposable, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { FileLock } from '@zukhruf/fs';

import { type RefUpdate, readRefUpdates } from './ref-update.ts';
import { writeCommitFiles } from './snapshot/commit-files.ts';
import { hasInstallDrift } from './snapshot/drift.ts';
import { installFor } from './snapshot/installs.ts';
import { runNx } from './snapshot/nx.ts';
import { linkPackages } from './snapshot/packages.ts';

const execFileAsync = promisify(execFile);

export class MissingLockfileError extends Error {
  readonly sha: string;

  constructor(sha: string) {
    super(`${sha.slice(0, 7)} has no package-lock.json`);
    this.name = 'MissingLockfileError';
    this.sha = sha;
  }
}

interface PushOptions {
  // The top of the working tree: the folder where git runs the hook.
  readonly root: string;
  readonly environment: NodeJS.ProcessEnv;
  // The name and the URL of the remote: the arguments of the hook.
  readonly remote: { readonly name: string; readonly url: string };
  // The standard input of the hook: one line for each ref update.
  readonly input: string;
  // Prints a line of progress, such as a wait for the lock or an install.
  readonly notice: (message: string) => void;
}

// What `git push` is about to send: the remote and the ref updates. A step
// judges the pushed commits in snapshots, never the working tree, because
// other sessions can edit the working tree while the hook runs.
export class Push {
  readonly remote: { readonly name: string; readonly url: string };
  readonly updates: readonly RefUpdate[];
  readonly #root: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #notice: (message: string) => void;

  private constructor(
    { root, environment, remote, notice }: PushOptions,
    updates: readonly RefUpdate[],
  ) {
    this.remote = remote;
    this.updates = updates;
    this.#root = root;
    this.#environment = environment;
    this.#notice = notice;
  }

  static async read(options: PushOptions): Promise<Push> {
    const git = (...args: string[]) =>
      gitIn(options.root, options.environment, ...args);
    return new Push(
      options,
      await readRefUpdates(git, options.remote.name, options.input),
    );
  }

  // Runs `work` on the snapshot of one commit: its files in a temporary
  // folder, with a node_modules that a build can use. `environment` makes git
  // see a clean checkout of the commit there, and holds the nx cache of the
  // state folder. One snapshot is open at a time in a repo; the snapshot is
  // deleted after `work`.
  async inSnapshot<T>(
    sha: string,
    work: (folder: string, environment: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> {
    const state = join(
      (
        await this.#git(
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        )
      ).trim(),
      'git-hooks',
    );
    await mkdir(state, { recursive: true });
    using lock = FileLock.open(join(state, 'lock'));
    if (!lock.tryLock()) {
      this.#notice('waiting for another pre-push build in this repo');
      while (!lock.tryLock()) await delay(200);
    }
    await using temporary = await mkdtempDisposable(
      join(tmpdir(), 'git-hooks-push-'),
    );
    const top = await realpath(temporary.path);
    const folder = join(top, 'tree');
    await writeCommitFiles(
      (...args) => this.#git(...args),
      { cwd: this.#root, env: this.#environment },
      sha,
      folder,
    );
    if (!existsSync(join(folder, 'package-lock.json')))
      throw new MissingLockfileError(sha);
    const installed = (await hasInstallDrift(
      join(folder, 'package-lock.json'),
      join(this.#root, 'node_modules/.package-lock.json'),
    ))
      ? await installFor(state, folder, this.#environment, () =>
          this.#notice(
            `${sha.slice(0, 7)}: the installed packages differ from package-lock.json; installing it with npm ci (first time for this lockfile)`,
          ),
        )
      : this.#root;
    await linkPackages(installed, folder);
    const cache = join(state, 'nx');
    const environment = {
      ...this.#environment,
      GIT_DIR: (await this.#git('rev-parse', '--absolute-git-dir')).trim(),
      GIT_WORK_TREE: folder,
      GIT_INDEX_FILE: join(top, 'index'),
      NX_DAEMON: 'false',
      NX_CACHE_DIRECTORY: cache,
      NX_WORKSPACE_DATA_DIRECTORY: join(cache, 'workspace-data'),
    };
    // A temporary index of the commit, refreshed against the snapshot, so git
    // finds no changed and no untracked files.
    await gitIn(folder, environment, 'read-tree', sha);
    await gitIn(folder, environment, 'update-index', '-q', '--refresh');
    // Awaited here, so the snapshot and the lock stay until `work` ends.
    return await work(folder, environment);
  }

  // Runs nx in the snapshot of one commit, and gives its standard output.
  // When nx exits with a code other than 0, it throws.
  nx(sha: string, ...args: string[]): Promise<string> {
    return this.inSnapshot(sha, async (folder, environment) => {
      const { code, stdout, stderr } = await runNx(folder, environment, args);
      if (code !== 0)
        throw new Error(
          `nx ${args.join(' ')} exited with ${code}:\n${`${stdout}${stderr}`.trimEnd()}`,
        );
      return stdout;
    });
  }

  #git(...args: string[]): Promise<string> {
    return gitIn(this.#root, this.#environment, ...args);
  }
}

async function gitIn(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 2 ** 30,
  });
  return stdout;
}
