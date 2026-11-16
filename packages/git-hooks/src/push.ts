import { join } from 'node:path';

import { type WallClock, poll } from '@zukhruf/async';
import { FileLock } from '@zukhruf/fs';

import { type Git, gitIn } from './git.ts';
import { type RefUpdate, readRefUpdates } from './ref-update.ts';
import { runNx } from './snapshot/nx.ts';
import { Snapshots, stateFolder } from './snapshot/snapshots.ts';
import { type DiffEntry, Tree, changesBetween } from './tree.ts';

interface PushOptions {
  // The top of the working tree: the folder where git runs the hook.
  readonly root: string;
  // The hook environment, for the git commands on the repo.
  readonly environment: NodeJS.ProcessEnv;
  // The hook environment without the git variables of the repo, for each
  // tool: git in a snapshot, npm and nx.
  readonly toolEnvironment: NodeJS.ProcessEnv;
  // The name and the URL of the remote: the arguments of the hook.
  readonly remote: { readonly name: string; readonly url: string };
  // The standard input of the hook: one line for each ref update.
  readonly input: string;
  // Prints a line of progress, such as a wait for the lock or an install.
  readonly notice: (message: string) => void;
  // The clock of the wait for the lock, and of the time of each install:
  // `globalThis` in a hook, a fake clock in a test.
  readonly clock: WallClock;
}

// What `git push` is about to send: the remote and the ref updates. A step
// judges the pushed commits in snapshots, never the working tree, because
// other sessions can edit the working tree while the hook runs.
export class Push {
  readonly remote: { readonly name: string; readonly url: string };
  readonly updates: readonly RefUpdate[];
  readonly #root: string;
  readonly #toolEnvironment: NodeJS.ProcessEnv;
  readonly #git: Git;
  readonly #notice: (message: string) => void;
  readonly #clock: WallClock;

  private constructor(
    { root, toolEnvironment, remote, notice, clock }: PushOptions,
    git: Git,
    updates: readonly RefUpdate[],
  ) {
    this.remote = remote;
    this.updates = updates;
    this.#root = root;
    this.#toolEnvironment = toolEnvironment;
    this.#git = git;
    this.#notice = notice;
    this.#clock = clock;
  }

  static async read(options: PushOptions): Promise<Push> {
    const git = gitIn(options.root, options.environment);
    return new Push(
      options,
      git,
      await readRefUpdates(git, options.remote.name, options.input),
    );
  }

  // The tree of one commit.
  async tree(sha: string): Promise<Tree> {
    return Tree.list(
      (await this.#git('rev-parse', '--verify', `${sha}^{tree}`)).trim(),
      this.#git,
    );
  }

  // The diff entries of a create or an update: from the tree of its base to
  // the tree of its head, or from the empty tree when there is no base.
  changes(
    update: Extract<RefUpdate, { kind: 'create' | 'update' }>,
  ): Promise<readonly DiffEntry[]> {
    return changesBetween(this.#git, update.base, update.head);
  }

  // Runs `work` on the snapshot of one commit: a clone of the repo in a
  // temporary folder with a checkout of the commit, and a node_modules that a
  // build can use. The clone shares the objects of the repo, so it copies
  // none, and git commands in it see a clean checkout of the commit. The
  // environment has none of git's variables of the repo, so a tool that runs
  // git in another folder never reaches the repo, and it holds the nx cache of
  // the state folder. One snapshot is open at a time in a repo; the snapshot
  // is deleted after `work`.
  async inSnapshot<T>(
    sha: string,
    work: (folder: string, environment: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> {
    using lock = FileLock.open(join(await stateFolder(this.#git), 'lock'));
    if (!lock.tryLock()) {
      this.#notice('waiting for another pre-push build in this repo');
      await poll(async () => (lock.tryLock() ? true : undefined), {
        interval: 200,
        clock: this.#clock,
        signal: undefined,
      });
    }
    await using snapshots = new Snapshots({
      root: this.#root,
      git: this.#git,
      toolEnvironment: this.#toolEnvironment,
      notice: this.#notice,
      clock: this.#clock,
    });
    const { folder, environment } = await snapshots.open(
      sha,
      sha.slice(0, 7),
      true,
    );
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
}
