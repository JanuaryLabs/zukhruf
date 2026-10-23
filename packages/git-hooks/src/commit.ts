import { execFile } from 'node:child_process';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// The staged commit: the index of the repo at `root`. Each read of a staged
// file goes to its staged copy, never to the working tree, because other
// sessions can edit the working tree while the hook runs. The environment is
// the hook's own, so git keeps the index that `git commit` gave it in
// GIT_INDEX_FILE.
export class Commit {
  readonly root: string;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(root: string, environment: NodeJS.ProcessEnv) {
    this.root = root;
    this.#environment = environment;
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

  // The staged copy of one file.
  blob(path: string): Promise<string> {
    return this.#git('cat-file', 'blob', `:${path}`);
  }

  // Whether the commit stages a path that matches one of the globs.
  async touches(globs: readonly string[]): Promise<boolean> {
    const staged = await this.staged();
    return staged.some((path) => globs.some((glob) => matchesGlob(path, glob)));
  }

  // Runs `work` on a copy of the staged tree in a temporary folder, for a
  // check that reads many files at once. The folder is removed afterwards.
  async inSnapshot<T>(work: (folder: string) => Promise<T>): Promise<T> {
    await using snapshot = await mkdtempDisposable(
      join(tmpdir(), 'git-hooks-'),
    );
    await this.#git('checkout-index', '--all', `--prefix=${snapshot.path}/`);
    return work(snapshot.path);
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
  // agent shell does not leave a daemon behind or read its stale graph.
  async nx(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(
      join(this.root, 'node_modules/.bin/nx'),
      args,
      {
        cwd: this.root,
        env: { ...this.#environment, NX_DAEMON: 'false' },
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

  async #git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: this.root,
      env: this.#environment,
      encoding: 'utf8',
      // A staged file of any size, not Node's default of 1 MiB.
      maxBuffer: 2 ** 30,
    });
    return stdout;
  }
}
