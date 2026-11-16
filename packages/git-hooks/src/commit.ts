import { execFile } from 'node:child_process';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { type Git, gitIn } from './git.ts';
import { withoutRepoVariables } from './repo-variables.ts';
import { type DiffEntry, Tree, changesBetween, matches } from './tree.ts';

const execFileAsync = promisify(execFile);

// The staged commit: the index of the repo at `root`. Each read of a staged
// file goes to its staged copy, never to the working tree, because other
// sessions can edit the working tree while the hook runs. The git commands get
// the hook environment, so git keeps the index that `git commit` gave the hook
// in GIT_INDEX_FILE. Each tool gets the tool environment, which the host
// computes. A repo's own test that builds a Commit gives one environment, and
// the tool environment then comes from it.
export class Commit {
  readonly root: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #toolEnvironment: NodeJS.ProcessEnv | undefined;
  readonly #git: Git;

  constructor(
    root: string,
    environment: NodeJS.ProcessEnv,
    toolEnvironment?: NodeJS.ProcessEnv,
  ) {
    this.root = root;
    this.#environment = environment;
    this.#toolEnvironment = toolEnvironment;
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
      await this.#headTree(),
      await this.#stagedTree(),
    );
  }

  // Whether a diff entry of the commit matches one of the globs. A deleted
  // path counts, so a commit that only deletes a file that a step watches
  // still starts the step.
  async touches(globs: readonly string[]): Promise<boolean> {
    return (await this.changes()).some(({ path }) => matches(path, globs));
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
          ...(this.#toolEnvironment ??
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

  async #stagedTree(): Promise<string> {
    return (await this.#git('write-tree')).trim();
  }

  // The tree of HEAD, or undefined before the first commit.
  async #headTree(): Promise<string | undefined> {
    try {
      return (
        await this.#git('rev-parse', '--verify', '--quiet', 'HEAD^{tree}')
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
