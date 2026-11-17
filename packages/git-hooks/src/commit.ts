import { spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { text } from 'node:stream/consumers';

import { TemporaryFiles } from '@zukhruf/fs';

import { type Git, gitIn } from './git.ts';
import { PackagedSnapshot, Snapshot } from './snapshot/snapshot.ts';
import type { Snapshots } from './snapshot/snapshots.ts';
import { type DiffEntry, Tree, changesBetween, matches } from './tree.ts';

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

// What `generate` did with the files that its work wrote. A commit that names
// its paths (`git commit --only`, `git commit <paths>`) commits a temporary
// index that the hook cannot add to, so there the files are not staged.
export type Generated =
  | { readonly kind: 'staged'; readonly entries: readonly DiffEntry[] }
  | {
      readonly kind: 'not-staged';
      readonly entries: readonly DiffEntry[];
      readonly reason: string;
    };

interface CommitOptions {
  // The top of the working tree: the folder where git runs the hook.
  readonly root: string;
  // The hook environment, for the git commands on the repo.
  readonly environment: NodeJS.ProcessEnv;
  // The snapshots of the hook, which the runner deletes at the end.
  readonly snapshots: Snapshots;
  // Prints a line under the current step, such as a working-tree copy that
  // generate left alone.
  readonly notice: (message: string) => void;
  // Gets the staged tree after each generate that staged files.
  readonly generated: (tree: string) => void;
}

// The staged commit: the index of the repo at `root`. Each read of a staged
// file goes to its staged copy, never to the working tree, because other
// sessions can edit the working tree while the hook runs. The git commands get
// the hook environment, so git keeps the index that `git commit` gave the hook
// in GIT_INDEX_FILE. Each tool gets the tool environment, which the host
// computes, in the snapshots of the hook.
export class Commit {
  readonly #root: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #snapshots: Snapshots;
  readonly #notice: (message: string) => void;
  readonly #generated: (tree: string) => void;
  readonly #git: Git;

  constructor({
    root,
    environment,
    snapshots,
    notice,
    generated,
  }: CommitOptions) {
    this.#root = root;
    this.#environment = environment;
    this.#snapshots = snapshots;
    this.#notice = notice;
    this.#generated = generated;
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
    const clone = await this.#snapshots.open(
      await this.#stagedCommit(),
      'the staged commit',
      packages,
    );
    return packages ? new PackagedSnapshot(clone) : new Snapshot(clone);
  }

  // Runs `work` in a private snapshot of the staged commit, with packages,
  // and stages each file that the work changed there and that matches one of
  // the globs: new, modified and deleted files, links and the executable bit
  // as written. The index of the hook gets them; the working-tree copy of a
  // file changes too, but only when it is still the old staged copy, because
  // another session may be editing it. `work` fails by throwing, and then
  // nothing is staged.
  async generate(
    globs: readonly string[],
    work: (snapshot: PackagedSnapshot) => Promise<void>,
  ): Promise<Generated> {
    await using clone = await this.#snapshots.openPrivate(
      await this.#stagedCommit(),
      'the staged commit',
    );
    await work(new PackagedSnapshot(clone));
    const entries = await written(
      gitIn(clone.folder, clone.environment),
      clone.folder,
      globs,
    );
    if (entries.length === 0) return { kind: 'staged', entries };
    const lines: string[] = [];
    for (const entry of entries) {
      const staged = await this.#revision(`:${entry.path}`);
      const copy = await this.#workingObject(entry.path);
      if (entry.change === 'deleted') {
        lines.push(`0 ${'0'.repeat(this.#nullLength(staged))}\t${entry.path}`);
        if (copy === staged)
          await rm(join(this.#root, entry.path), { force: true });
        else this.#leftAlone(entry.path);
        continue;
      }
      const source = join(clone.folder, entry.path);
      const { mode, object } = await this.#store(entry.path, source);
      lines.push(`${mode} ${object}\t${entry.path}`);
      if (copy === staged) await place(source, join(this.#root, entry.path));
      else this.#leftAlone(entry.path);
    }
    if (isPartialCommit(this.#environment))
      return {
        kind: 'not-staged',
        entries,
        reason: [
          'this commit names its paths (git commit --only or git commit <paths>), so the hook cannot stage what it generated:',
          ...entries.map(({ path }) => `  ${path}`),
          `Commit them with your paths: git commit --only <your paths> ${entries.map(({ path }) => path).join(' ')}`,
        ].join('\n'),
      };
    await this.#updateIndex(`${lines.join('\n')}\n`);
    this.#generated(await this.#stagedTree());
    return { kind: 'staged', entries };
  }

  // The object of the working-tree copy of `path` as git would store it, or
  // undefined when there is none.
  async #workingObject(path: string): Promise<string | undefined> {
    const file = join(this.#root, path);
    const stats = await lstat(file).catch(() => undefined);
    if (stats === undefined) return undefined;
    if (stats.isSymbolicLink())
      return (
        await gitWithInput(
          this.#root,
          this.#environment,
          await readlink(file),
          ['hash-object', '--stdin'],
        )
      ).trim();
    return (
      await this.#git('hash-object', `--path=${path}`, '--', file)
    ).trim();
  }

  // Writes the file at `source` into the object store of the repo, as the
  // content of `path`, and gives its mode and object.
  async #store(
    path: string,
    source: string,
  ): Promise<{ mode: string; object: string }> {
    const stats = await lstat(source);
    if (stats.isSymbolicLink())
      return {
        mode: '120000',
        object: (
          await gitWithInput(
            this.#root,
            this.#environment,
            await readlink(source),
            ['hash-object', '-w', '--stdin'],
          )
        ).trim(),
      };
    return {
      mode: (stats.mode & 0o111) === 0 ? '100644' : '100755',
      object: (
        await this.#git('hash-object', '-w', `--path=${path}`, '--', source)
      ).trim(),
    };
  }

  // A null object id is all zeros, as long as the ids of the repo: 40 for
  // SHA-1, 64 for SHA-256.
  #nullLength(staged: string | undefined): number {
    return staged?.length ?? 40;
  }

  #leftAlone(path: string): void {
    this.#notice(
      `left the working-tree copy of ${path}: it has edits that are not staged`,
    );
  }

  // One update of the index of the hook. It takes the lock of the index, so
  // it fails while a peer's git command holds it.
  async #updateIndex(info: string): Promise<void> {
    try {
      await gitWithInput(this.#root, this.#environment, info, [
        'update-index',
        '--index-info',
      ]);
    } catch (error) {
      if (Error.isError(error) && /index\.lock/.test(error.message))
        throw new Error(
          'another git process holds the lock of the index, so the hook could not stage what it generated; commit again',
          { cause: error },
        );
      throw error;
    }
  }

  // `git write-tree` takes the lock of the index, to keep the trees that it
  // wrote, and fails while another process holds it: a peer's `git add`, or
  // the `git status` of an editor. A plain `git commit` does not lock the
  // index while the hook runs. So the tree is written from a private copy of
  // the index of the hook. No index file is an empty index.
  async #stagedTree(): Promise<string> {
    await using copy = await new TemporaryFiles().directory('git-hooks-index-');
    const index = join(copy.path, 'index');
    try {
      await copyFile(
        resolve(
          this.#root,
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
      await gitIn(this.#root, { ...this.#environment, GIT_INDEX_FILE: index })(
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
      await gitIn(this.#root, { ...this.#environment, ...stagedCommitter })(
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

// The paths that `work` wrote in the clone, as diff entries against the
// commit that the clone checked out, that match one of the globs.
async function written(
  git: Git,
  folder: string,
  globs: readonly string[],
): Promise<DiffEntry[]> {
  const status = await git(
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
  );
  const entries: DiffEntry[] = [];
  for (const record of status.split('\0')) {
    if (record === '') continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (!matches(path, globs)) continue;
    if (code.includes('D')) {
      entries.push({ change: 'deleted', path });
      continue;
    }
    const kind = (await lstat(join(folder, path))).isSymbolicLink()
      ? 'link'
      : 'file';
    const change =
      code === '??'
        ? 'added'
        : code.includes('T')
          ? 'type-changed'
          : 'modified';
    entries.push({ change, path, kind });
  }
  return entries;
}

// Writes the file or link at `source` to `destination`, with its executable
// bit.
async function place(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await rm(destination, { force: true });
  const stats = await lstat(source);
  if (stats.isSymbolicLink())
    return symlink(await readlink(source), destination);
  await copyFile(source, destination);
  await chmod(destination, stats.mode & 0o777);
}

// git runs the pre-commit hook of `git commit --only` or `git commit <paths>`
// with a temporary index, `next-index-<pid>.lock`, that it commits and then
// drops. A file staged there is in the commit, but the index of the repo does
// not get it, so the next commit would undo it. The name is the only sign of
// that mode: a predicting check, because no harmless trial tells the modes
// apart.
function isPartialCommit(environment: NodeJS.ProcessEnv): boolean {
  return basename(environment.GIT_INDEX_FILE ?? '').startsWith('next-index-');
}

async function gitWithInput(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  input: string,
  args: readonly string[],
): Promise<string> {
  const child = spawn('git', args, {
    cwd,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(input);
  const [stdout, stderr, code] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }),
  ]);
  if (code !== 0)
    throw new Error(
      `git ${args.join(' ')} exited with ${code}: ${stderr.trim()}`,
    );
  return stdout;
}
