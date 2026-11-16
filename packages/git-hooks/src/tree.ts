import { posix } from 'node:path';

import type { Git } from './git.ts';

// One path of a tree, with its kind. An executable file is a file too. A tree
// lists no folders. The term is libgit2's (`git_tree_entry`).
export interface TreeEntry {
  readonly path: string;
  readonly kind: 'file' | 'link' | 'submodule';
}

// One path that differs between two trees, with git's word for the change
// (`--diff-filter`). A deleted path has no new entry, so it has no kind. The
// term is JGit's (`DiffEntry`).
export type DiffEntry =
  | {
      readonly change: 'added' | 'modified' | 'type-changed';
      readonly path: string;
      readonly kind: TreeEntry['kind'];
    }
  | { readonly change: 'deleted'; readonly path: string };

interface Listed extends TreeEntry {
  readonly object: string;
}

// Git's tree object: the paths of a commit, with the mode and the content of
// each. A tree does not change, so it lists its entries one time, when it is
// made, and a step that reads it judges one state of the commit, also when
// the index changes while the hook runs.
export class Tree {
  readonly id: string;
  readonly #git: Git;
  readonly #entries: ReadonlyMap<string, Listed>;

  private constructor(
    id: string,
    git: Git,
    entries: ReadonlyMap<string, Listed>,
  ) {
    this.id = id;
    this.#git = git;
    this.#entries = entries;
  }

  // The tree `id` of the repo that `git` reads.
  static async list(id: string, git: Git): Promise<Tree> {
    const output = await git('ls-tree', '-r', '-z', '--full-tree', id);
    const entries = new Map<string, Listed>();
    for (const record of output.split('\0')) {
      if (record === '') continue;
      // `<mode> SP <type> SP <object> TAB <path>`
      const tab = record.indexOf('\t');
      const [mode = '', , object = ''] = record.slice(0, tab).split(' ');
      const path = record.slice(tab + 1);
      entries.set(path, { path, kind: kindOf(mode), object });
    }
    return new Tree(id, git, entries);
  }

  // The entries whose path matches one of the globs, or each entry.
  entries(globs?: readonly string[]): readonly TreeEntry[] {
    const entries = [...this.#entries.values()].map(({ path, kind }) => ({
      path,
      kind,
    }));
    return globs === undefined
      ? entries
      : entries.filter(({ path }) => matches(path, globs));
  }

  // The content of the file or the link at `path`, as UTF-8 text: the text of
  // a link is the path that it points to. A submodule has no content in this
  // repo.
  async read(path: string): Promise<string | undefined> {
    const entry = this.#entries.get(path);
    if (entry === undefined || entry.kind === 'submodule') return undefined;
    return this.#git('cat-file', 'blob', entry.object);
  }
}

// Whether `path` matches one of the globs. A path of a tree always uses `/`,
// so the globs match as on POSIX, also on Windows.
export function matches(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => posix.matchesGlob(path, glob));
}

// The diff entries from the tree `from` to the tree `to`. With no `from`, the
// diff starts from the empty tree, so each entry of `to` is added. A rename is
// a deleted entry and an added entry.
export async function changesBetween(
  git: Git,
  from: string | undefined,
  to: string,
): Promise<DiffEntry[]> {
  const base =
    from ?? (await git('hash-object', '-t', 'tree', '--stdin')).trim();
  const output = await git('diff-tree', '-r', '-z', '--no-renames', base, to);
  // `:<old mode> SP <new mode> SP <old object> SP <new object> SP <letter>`,
  // then the path, each ended by NUL.
  const fields = output.split('\0');
  const changes: DiffEntry[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [, mode = '', , , letter = ''] = (fields[index] ?? '').split(' ');
    const path = fields[index + 1] ?? '';
    const change = changeOf(letter);
    changes.push(
      change === 'deleted'
        ? { change, path }
        : { change, path, kind: kindOf(mode) },
    );
  }
  return changes;
}

function kindOf(mode: string): TreeEntry['kind'] {
  if (mode === '120000') return 'link';
  if (mode === '160000') return 'submodule';
  return 'file';
}

function changeOf(letter: string): DiffEntry['change'] {
  switch (letter) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'T':
      return 'type-changed';
    case 'D':
      return 'deleted';
    default:
      throw new TypeError(
        `git diff-tree gave the change "${letter}", which a diff of two trees without renames never has`,
      );
  }
}
