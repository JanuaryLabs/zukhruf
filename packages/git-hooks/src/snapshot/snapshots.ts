import { existsSync } from 'node:fs';
import { mkdir, mkdtempDisposable, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Latch } from '@zukhruf/async';

import { type Git, gitIn } from '../git.ts';
import { hasInstallDrift } from './drift.ts';
import { installFor } from './installs.ts';
import { linkPackages } from './packages.ts';

export class MissingLockfileError extends Error {
  constructor(commit: string) {
    super(`${commit} has no package-lock.json`);
    this.name = 'MissingLockfileError';
  }
}

// One clone of the repo, checked out at a commit, in a temporary folder.
export interface Clone {
  readonly folder: string;
  // The tool environment, with NX_DAEMON=false and the nx cache of the state
  // folder.
  readonly environment: NodeJS.ProcessEnv;
  readonly nxCacheDirectory: string;
}

// The outcome of one piece of work, kept as data in a latch, so a failure
// rejects only the callers that wait for it.
type Outcome<T> = Latch<PromiseSettledResult<T>>;

interface SnapshotsOptions {
  // The top of the working tree: the folder where git runs the hook.
  readonly root: string;
  // git on the repo, with the hook environment.
  readonly git: Git;
  // The hook environment without the git variables of the repo.
  readonly toolEnvironment: NodeJS.ProcessEnv;
  // Prints a line of progress, such as an install.
  readonly notice: (message: string) => void;
  // The clock of the time of each install: `globalThis` in a hook.
  readonly clock: { readonly Date: { now(): number } };
}

// The folder `git-hooks` in the common git folder of the repo, where both
// hooks keep the installs and the nx cache. Linked worktrees use the same one.
export async function stateFolder(git: Git): Promise<string> {
  const state = join(
    (
      await git('rev-parse', '--path-format=absolute', '--git-common-dir')
    ).trim(),
    'git-hooks',
  );
  await mkdir(state, { recursive: true });
  return state;
}

// The snapshots of one run of a hook: one clone of the repo for each commit,
// made at the first ask. The clone shares the objects of the repo
// (`git clone --shared`), so git copies none, and git commands in it see a
// clean checkout of the commit. A later ask for packages links a node_modules
// into the same clone. Disposing deletes each clone.
export class Snapshots implements AsyncDisposable {
  readonly toolEnvironment: NodeJS.ProcessEnv;
  readonly #root: string;
  readonly #git: Git;
  readonly #notice: (message: string) => void;
  readonly #clock: SnapshotsOptions['clock'];
  readonly #stack = new AsyncDisposableStack();
  readonly #clones = new Map<string, Outcome<Clone>>();
  readonly #packages = new Map<string, Outcome<void>>();

  constructor({ root, git, toolEnvironment, notice, clock }: SnapshotsOptions) {
    this.toolEnvironment = toolEnvironment;
    this.#root = root;
    this.#git = git;
    this.#notice = notice;
    this.#clock = clock;
  }

  // The clone of `commit`, with a node_modules when `packages` is true.
  // `name` names the commit in a notice or an error.
  async open(commit: string, name: string, packages: boolean): Promise<Clone> {
    const clone = await settled(
      once(this.#clones, commit, () => this.#clone(commit)),
    );
    if (packages)
      await settled(
        once(this.#packages, commit, () => this.#link(clone, name)),
      );
    return clone;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#stack.disposeAsync();
  }

  async #clone(commit: string): Promise<Clone> {
    const cache = join(await stateFolder(this.#git), 'nx');
    const temporary = this.#stack.use(
      await mkdtempDisposable(join(tmpdir(), 'git-hooks-snapshot-')),
    );
    const folder = join(await realpath(temporary.path), 'tree');
    await gitIn(temporary.path, this.toolEnvironment)(
      'clone',
      '--shared',
      '--no-checkout',
      '--quiet',
      this.#root,
      folder,
    );
    await gitIn(folder, this.toolEnvironment)(
      'checkout',
      '--detach',
      '--quiet',
      commit,
    );
    return {
      folder,
      nxCacheDirectory: cache,
      environment: {
        ...this.toolEnvironment,
        NX_DAEMON: 'false',
        NX_CACHE_DIRECTORY: cache,
        NX_WORKSPACE_DATA_DIRECTORY: join(cache, 'workspace-data'),
      },
    };
  }

  // Uses the packages that the repo installed when they match the lockfile
  // of the commit, and else an install of that lockfile in the state folder.
  async #link(clone: Clone, name: string): Promise<void> {
    const lockfile = join(clone.folder, 'package-lock.json');
    if (!existsSync(lockfile)) throw new MissingLockfileError(name);
    const installed = (await hasInstallDrift(
      lockfile,
      join(this.#root, 'node_modules/.package-lock.json'),
    ))
      ? await installFor(
          await stateFolder(this.#git),
          clone.folder,
          this.toolEnvironment,
          () =>
            this.#notice(
              `${name}: the installed packages differ from package-lock.json; installing it with npm ci (first time for this lockfile)`,
            ),
          this.#clock,
        )
      : this.#root;
    await linkPackages(installed, clone.folder);
  }
}

// The outcome of `work` for `key`: the work starts at the first ask, and each
// later ask waits for the same outcome.
function once<T>(
  outcomes: Map<string, Outcome<T>>,
  key: string,
  work: () => Promise<T>,
): Outcome<T> {
  const known = outcomes.get(key);
  if (known !== undefined) return known;
  const outcome: Outcome<T> = new Latch();
  outcomes.set(key, outcome);
  void Promise.allSettled([Promise.try(work)]).then(([result]) =>
    outcome.open(result),
  );
  return outcome;
}

async function settled<T>(outcome: Outcome<T>): Promise<T> {
  const result = await outcome.wait();
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}
