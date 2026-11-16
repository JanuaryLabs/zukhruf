import { type Git, gitIn } from './git.ts';
import { type RefUpdate, readRefUpdates } from './ref-update.ts';
import { runNx } from './snapshot/nx.ts';
import { PackagedSnapshot, Snapshot } from './snapshot/snapshot.ts';
import type { Snapshots } from './snapshot/snapshots.ts';
import { type DiffEntry, Tree, changesBetween } from './tree.ts';

interface PushOptions {
  // The top of the working tree: the folder where git runs the hook.
  readonly root: string;
  // The hook environment, for the git commands on the repo.
  readonly environment: NodeJS.ProcessEnv;
  // The snapshots of the hook, which the runner deletes at the end.
  readonly snapshots: Snapshots;
  // The name and the URL of the remote: the arguments of the hook.
  readonly remote: { readonly name: string; readonly url: string };
  // The standard input of the hook: one line for each ref update.
  readonly input: string;
}

// What `git push` is about to send: the remote and the ref updates. A step
// judges the pushed commits in snapshots, never the working tree, because
// other sessions can edit the working tree while the hook runs.
export class Push {
  readonly remote: { readonly name: string; readonly url: string };
  readonly updates: readonly RefUpdate[];
  readonly #git: Git;
  readonly #snapshots: Snapshots;

  private constructor(
    { snapshots, remote }: PushOptions,
    git: Git,
    updates: readonly RefUpdate[],
  ) {
    this.remote = remote;
    this.updates = updates;
    this.#git = git;
    this.#snapshots = snapshots;
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

  // The snapshot of one pushed commit. The first snapshot of a push takes the
  // build lock of the repo, so one pre-push build runs at a time; a push with
  // many heads keeps the clone of one head at a time. With packages, it also
  // has a node_modules from the commit's own lockfile.
  snapshot(
    sha: string,
    options?: { readonly packages?: false },
  ): Promise<Snapshot>;
  snapshot(
    sha: string,
    options: { readonly packages: true },
  ): Promise<PackagedSnapshot>;
  async snapshot(
    sha: string,
    { packages = false }: { readonly packages?: boolean } = {},
  ): Promise<Snapshot> {
    const clone = await this.#snapshots.open(sha, sha.slice(0, 7), packages);
    return packages ? new PackagedSnapshot(clone) : new Snapshot(clone);
  }

  // Runs `work` with the folder and the environment of the packaged snapshot
  // of one commit.
  async inSnapshot<T>(
    sha: string,
    work: (folder: string, environment: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> {
    const { folder, environment } = await this.#snapshots.open(
      sha,
      sha.slice(0, 7),
      true,
    );
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
