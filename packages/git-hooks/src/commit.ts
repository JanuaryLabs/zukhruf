import { execFile } from 'node:child_process';
import { copyFile, mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { type Git, gitIn } from './git.ts';
import { withoutRepoVariables } from './repo-variables.ts';
import { PackagedSnapshot, Snapshot } from './snapshot/snapshot.ts';
import type { Snapshots } from './snapshot/snapshots.ts';
import { type DiffEntry, Tree, changesBetween, matches } from './tree.ts';

const execFileAsync = promisify(execFile);

// The author and the committer of the commit that the hook writes from the
// staged tree. They do not change, so one tree and one parent give one commit.
const stagedCommitter = {
  GIT_AUTHOR_NAME: 'git-hooks',
  GIT_AUTHOR_EMAIL: 'git-hooks@localhost',
  GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'git-hooks',
  GIT_COMMITTER_EMAIL: 'git-hooks@localhost',
  GIT_COMMITTER_DATE: '@0 +0000',
};

// The staged commit: the index of the repo at `root`. Each read of a staged
// file goes to its staged copy, never to the working tree, because other
// sessions can edit the working tree while the hook runs. The git commands get
// the hook environment, so git keeps the index that `git commit` gave the hook
// in GIT_INDEX_FILE. Each tool gets the tool environment, which the host
// computes, in the snapshots of the hook. A repo's own test that builds a
// Commit gives one environment and no snapshots; the tool environment then
// comes from that environment.
export class Commit {
  readonly root: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #snapshots: Snapshots | undefined;
  readonly #git: Git;

  constructor(
    root: string,
    environment: NodeJS.ProcessEnv,
    snapshots?: Snapshots,
  ) {
    this.root = root;
    this.#environment = environment;
    this.#snapshots = snapshots;
    this.#git = gitIn(root, environment);
  }

  // The staged tree: the tree that `git write-tree` writes from the index of
  // the hook. Each call writes the tree of the index as it is then.
  async tree(): Promise<Tree> {
    return Tree.list(await this.#stagedTree(), this.#git);
  }

  // The diff entries from the tree of HEAD to the staged tree. A first commit
  // diffs from the empty tree.
  async changes(): Promise<readonly DiffEntry[]> {
    return changesBetween(
      this.#git,
      await this.#revision('HEAD^{tree}'),
      await this.#stagedTree(),
    );
  }

  // Whether a diff entry of the commit matches one of the globs. A deleted
  // path counts, so a commit that only deletes a file that a step watches
  // still starts the step.
  async touches(globs: readonly string[]): Promise<boolean> {
    return (await this.changes()).some(({ path }) => matches(path, globs));
  }

  // The snapshot of the staged tree: a checkout of a commit that the hook
  // writes from the staged tree, with HEAD as its parent. The steps of one run
  // of the hook share one snapshot of one tree. With packages, it also has a
  // node_modules from the install of the staged lockfile.
  snapshot(options?: { readonly packages?: false }): Promise<Snapshot>;
  snapshot(options: { readonly packages: true }): Promise<PackagedSnapshot>;
  async snapshot({
    packages = false,
  }: { readonly packages?: boolean } = {}): Promise<Snapshot> {
    if (this.#snapshots === undefined)
      throw new TypeError(
        'this Commit has no snapshots: preCommit builds the Commit that has them',
      );
    const clone = await this.#snapshots.open(
      await this.#stagedCommit(),
      'the staged commit',
      packages,
    );
    return packages ? new PackagedSnapshot(clone) : new Snapshot(clone);
  }

  // The paths that the commit adds, copies, modifies or renames.
  async staged(): Promise<string[]> {
    const output = await this.#git(
      'diff',
      '--cached',
      '--name-only',
      '--diff-filter=ACMR',
      '-z',
    );
    return output.split('\0').filter((path) => path !== '');
  }

  // The staged paths whose staged copy is the content of a file. The staged
  // copy of a link is the path that it points to, and that of a submodule is
  // a commit id, so a check of their content would judge the wrong text.
  async files(): Promise<string[]> {
    const entries = await this.#git('ls-files', '--stage', '-z');
    const files = new Set(
      entries
        .split('\0')
        .filter((entry) => /^100(644|755) /.test(entry))
        .map((entry) => entry.slice(entry.indexOf('\t') + 1)),
    );
    return (await this.staged()).filter((path) => files.has(path));
  }

  // The staged copy of one file.
  blob(path: string): Promise<string> {
    return this.#git('cat-file', 'blob', `:${path}`);
  }

  // Runs `work` on a copy of the staged tree in a temporary folder, for a
  // check that reads many files at once. The folder is removed afterwards.
  async inSnapshot<T>(work: (folder: string) => Promise<T>): Promise<T> {
    await using snapshot = await mkdtempDisposable(
      join(tmpdir(), 'git-hooks-'),
    );
    await this.#git('checkout-index', '--all', `--prefix=${snapshot.path}/`);
    // Awaited here, so the folder stays until `work` ends.
    return await work(snapshot.path);
  }

  // The tracked files whose working-tree copy differs from the staged copy.
  async modified(): Promise<string[]> {
    const output = await this.#git('diff', '--name-only', '-z');
    return output.split('\0').filter((path) => path !== '');
  }

  // Stages files that a step wrote itself. A step never stages anything else.
  async stage(paths: readonly string[]): Promise<void> {
    await this.#git('add', '--', ...paths);
  }

  // Runs the repo's own nx with no daemon, so a hook started from a GUI or an
  // agent shell does not leave a daemon behind or read its stale graph. nx
  // and its tasks get none of git's variables of the repo, so a task that
  // runs git in its own folder never reaches the repo. The git commands of
  // the commit keep them, so they read and write the commit's index.
  async nx(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(
      join(this.root, 'node_modules/.bin/nx'),
      args,
      {
        cwd: this.root,
        env: {
          ...(this.#snapshots?.toolEnvironment ??
            (await withoutRepoVariables(this.#environment))),
          NX_DAEMON: 'false',
        },
        encoding: 'utf8',
        maxBuffer: 2 ** 30,
      },
    );
    return stdout;
  }

  // The nx projects that the staged files affect. The files come from the
  // staged commit, so an edit that is only in the working tree affects nothing.
  async affected(): Promise<string[]> {
    const staged = await this.staged();
    if (staged.length === 0) return [];
    const output = await this.nx(
      'show',
      'projects',
      '--affected',
      `--files=${staged.join(',')}`,
      '--json',
    );
    const projects: unknown = JSON.parse(output);
    if (
      !Array.isArray(projects) ||
      !projects.every(
        (project): project is string => typeof project === 'string',
      )
    )
      throw new TypeError(
        `nx show projects gave ${output.trim()}, not a list of names`,
      );
    return projects;
  }

  // `git write-tree` takes the lock of the index, to keep the trees that it
  // wrote, and fails while another process holds it: a peer's `git add`, or
  // the `git status` of an editor. A plain `git commit` does not lock the
  // index while the hook runs. So the tree is written from a private copy of
  // the index of the hook. No index file is an empty index.
  async #stagedTree(): Promise<string> {
    await using copy = await mkdtempDisposable(
      join(tmpdir(), 'git-hooks-index-'),
    );
    const index = join(copy.path, 'index');
    try {
      await copyFile(
        resolve(
          this.root,
          (await this.#git('rev-parse', '--git-path', 'index')).trim(),
        ),
        index,
      );
    } catch (error) {
      if (
        !Error.isError(error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
    }
    return (
      await gitIn(this.root, { ...this.#environment, GIT_INDEX_FILE: index })(
        'write-tree',
      )
    ).trim();
  }

  // A commit of the staged tree, with HEAD as its parent, that no ref holds.
  // `git gc` prunes it.
  async #stagedCommit(): Promise<string> {
    const parent = await this.#revision('HEAD');
    const tree = await this.#stagedTree();
    return (
      await gitIn(this.root, { ...this.#environment, ...stagedCommitter })(
        'commit-tree',
        '--no-gpg-sign',
        '-m',
        'the staged tree',
        ...(parent === undefined ? [] : ['-p', parent]),
        tree,
      )
    ).trim();
  }

  // The object that `revision` names, or undefined before the first commit.
  async #revision(revision: string): Promise<string | undefined> {
    try {
      return (
        await this.#git('rev-parse', '--verify', '--quiet', revision)
      ).trim();
    } catch (error) {
      // With --quiet, rev-parse exits with 1 and says nothing when HEAD names
      // no commit yet.
      if (Error.isError(error) && 'code' in error && error.code === 1)
        return undefined;
      throw error;
    }
  }
}
