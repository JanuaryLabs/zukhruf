import { existsSync } from 'node:fs';
import { mkdir, mkdtempDisposable, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Latch, type WallClock, poll } from '@zukhruf/async';
import { FileLock } from '@zukhruf/fs';

import { type Git, gitIn } from '../git.ts';
import { hasInstallDrift } from './drift.ts';
import { installFor, leaseInstall } from './installs.ts';
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
  // The tool environment, with NX_DAEMON=false and the nx cache of the hook.
  readonly environment: NodeJS.ProcessEnv;
  readonly nxCacheDirectory: string;
}

// The outcome of one piece of work, kept as data in a latch, so a failure
// rejects only the callers that wait for it.
type Outcome<T> = Latch<PromiseSettledResult<T>>;

// A clone, and what its disposal frees: the folder, and the lease on the
// install that its node_modules links to.
interface Opened {
  readonly clone: Outcome<Clone>;
  packages: Outcome<void> | undefined;
  readonly resources: AsyncDisposableStack;
}

// How a hook uses snapshots. The pre-push hook builds: one build runs in a
// repo at a time, a push with many heads keeps one clone at a time, and its
// nx cache holds the run summary that Build reads. A pre-commit step only
// reads, so commits run at the same time as a push, with an nx cache of their
// own.
export type HookKind = 'pre-commit' | 'pre-push';

interface SnapshotsOptions {
  readonly hook: HookKind;
  // The top of the working tree: the folder where git runs the hook.
  readonly root: string;
  // git on the repo, with the hook environment.
  readonly git: Git;
  // The hook environment without the git variables of the repo.
  readonly toolEnvironment: NodeJS.ProcessEnv;
  // Prints a line of progress, such as an install or a wait for a lock.
  readonly notice: (message: string) => void;
  // The clock of the waits for a lock and of the time of each install:
  // `globalThis` in a hook.
  readonly clock: WallClock;
}

// The folder `git-hooks` in the common git folder of the repo, where both
// hooks keep the installs, the locks and the nx caches. Linked worktrees use
// the same one.
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
// clean checkout of the commit. A later ask for packages links a node_modules into the same clone. Disposing
// deletes each clone and lets each lock go.
export class Snapshots implements AsyncDisposable {
  readonly toolEnvironment: NodeJS.ProcessEnv;
  readonly #hook: HookKind;
  readonly #root: string;
  readonly #git: Git;
  readonly #notice: (message: string) => void;
  readonly #clock: WallClock;
  readonly #stack = new AsyncDisposableStack();
  readonly #opened = new Map<string, Opened>();
  // The build lock, taken at the first open of a pre-push snapshot.
  readonly #holdBuildLock = memoized(() => this.#acquireBuildLock());

  constructor({
    hook,
    root,
    git,
    toolEnvironment,
    notice,
    clock,
  }: SnapshotsOptions) {
    this.toolEnvironment = toolEnvironment;
    this.#hook = hook;
    this.#root = root;
    this.#git = git;
    this.#notice = notice;
    this.#clock = clock;
  }

  // The clone of `commit`, with a node_modules when `packages` is true.
  // `name` names the commit in a notice or an error.
  async open(commit: string, name: string, packages: boolean): Promise<Clone> {
    if (this.#hook === 'pre-push') {
      await this.#holdBuildLock();
      await this.#evictOtherThan(commit);
    }
    const opened = this.#opened.get(commit) ?? this.#start(commit);
    const clone = await settled(opened.clone);
    if (packages) {
      opened.packages ??= outcomeOf(() =>
        this.#link(clone, name, opened.resources),
      );
      await settled(opened.packages);
    }
    return clone;
  }

  // A clone of `commit` with packages that no other caller shares: a step
  // that writes files writes them there, so the steps that read the shared
  // snapshot never see them. Disposing it deletes the clone.
  async openPrivate(
    commit: string,
    name: string,
  ): Promise<Clone & AsyncDisposable> {
    const resources = new AsyncDisposableStack();
    try {
      const clone = await this.#clone(commit, resources);
      await this.#link(clone, name, resources);
      return {
        ...clone,
        [Symbol.asyncDispose]: () => resources.disposeAsync(),
      };
    } catch (error) {
      await resources.disposeAsync();
      throw error;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const opened of this.#opened.values())
      await opened.resources.disposeAsync();
    this.#opened.clear();
    await this.#stack.disposeAsync();
  }

  #start(commit: string): Opened {
    const resources = new AsyncDisposableStack();
    const opened: Opened = {
      clone: outcomeOf(() => this.#clone(commit, resources)),
      packages: undefined,
      resources,
    };
    this.#opened.set(commit, opened);
    return opened;
  }

  // A push with many heads builds one head after another: the clone of an
  // earlier head goes before the next one is made, as one build at a time
  // used one folder at a time.
  async #evictOtherThan(commit: string): Promise<void> {
    for (const [other, opened] of this.#opened)
      if (other !== commit) {
        this.#opened.delete(other);
        await opened.resources.disposeAsync();
      }
  }

  async #acquireBuildLock(): Promise<void> {
    const lock = await acquire(
      join(await stateFolder(this.#git), 'build.lock'),
      () => this.#notice('waiting for another pre-push build in this repo'),
      this.#clock,
    );
    this.#stack.use(lock);
  }

  async #clone(
    commit: string,
    resources: AsyncDisposableStack,
  ): Promise<Clone> {
    const cache = join(
      await stateFolder(this.#git),
      this.#hook === 'pre-push' ? 'nx' : 'nx-pre-commit',
    );
    const temporary = resources.use(
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
  // The install, its prune and the lease on it happen under one lock, so a
  // hook never deletes an install that a snapshot of another hook links to.
  async #link(
    clone: Clone,
    name: string,
    resources: AsyncDisposableStack,
  ): Promise<void> {
    const lockfile = join(clone.folder, 'package-lock.json');
    if (!existsSync(lockfile)) throw new MissingLockfileError(name);
    if (
      !(await hasInstallDrift(
        lockfile,
        join(this.#root, 'node_modules/.package-lock.json'),
      ))
    )
      return linkPackages(this.#root, clone.folder);
    const state = await stateFolder(this.#git);
    let installed: string;
    {
      using _ = await acquire(
        join(state, 'installs.lock'),
        () => this.#notice(`${name}: waiting for an install of another hook`),
        this.#clock,
      );
      installed = await installFor(
        state,
        clone.folder,
        this.toolEnvironment,
        () =>
          this.#notice(
            `${name}: the installed packages differ from package-lock.json; installing it with npm ci (first time for this lockfile)`,
          ),
        this.#clock,
      );
      resources.use(leaseInstall(installed));
    }
    await linkPackages(installed, clone.folder);
  }
}

// Takes the lock on the file at `path`, and waits while another process
// holds it.
async function acquire(
  path: string,
  waiting: () => void,
  clock: WallClock,
): Promise<FileLock> {
  const lock = FileLock.open(path);
  if (!lock.tryLock()) {
    waiting();
    await poll(async () => (lock.tryLock() ? true : undefined), {
      interval: 200,
      clock,
      signal: undefined,
    });
  }
  return lock;
}

// `work`, run at the first call; each later call waits for the same outcome.
function memoized<T>(work: () => Promise<T>): () => Promise<T> {
  let outcome: Outcome<T> | undefined;
  return () => settled((outcome ??= outcomeOf(work)));
}

// The outcome of `work`: it starts now, and each caller waits for the same
// outcome.
function outcomeOf<T>(work: () => Promise<T>): Outcome<T> {
  const outcome: Outcome<T> = new Latch();
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
