import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Git } from '../git.ts';

/**
 * The git facts about a set of workspace paths that claims rely on. Every
 * pathspec is literal, so a file name with a glob character names itself.
 */
export class ClaimedPaths {
  readonly #git: Git;

  constructor(git: Git) {
    this.#git = git;
  }

  async head(): Promise<string> {
    return (await this.#git.run(['rev-parse', '--verify', 'HEAD'])).trim();
  }

  /** The paths whose working tree or index differs from HEAD, untracked too. */
  async uncommitted(paths: readonly string[]): Promise<string[]> {
    const status = await this.#literal([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      ...paths,
    ]);
    // Each entry is "XY path"; a rename adds its source as one more entry.
    return paths.filter((path) =>
      status.split('\0').some((entry) => entry.slice(3) === path),
    );
  }

  /** The paths a commit between the two revisions changed; all with none. */
  async changedBetween(
    from: string,
    to: string,
    paths: readonly string[],
  ): Promise<string[]> {
    return names(
      await this.#literal([
        'diff',
        '--name-only',
        '-z',
        from,
        to,
        '--',
        ...paths,
      ]),
    );
  }

  /** The paths whose entry in the shared index differs from HEAD. */
  async staged(paths: readonly string[]): Promise<string[]> {
    return names(
      await this.#literal([
        'diff',
        '--cached',
        '--name-only',
        '-z',
        '--',
        ...paths,
      ]),
    );
  }

  /** Puts a path back as it was at a revision: its content, or no file. */
  async restore(revision: string, path: string): Promise<void> {
    const entry = await this.#literal(['ls-tree', '-z', revision, '--', path]);
    if (entry === '') {
      await rm(join(this.#git.directory, path), { force: true });
      return;
    }
    const file = join(this.#git.directory, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      await this.#git.bytes(['cat-file', 'blob', `${revision}:${path}`]),
    );
  }

  /** The paths a commit changed relative to its own parent. */
  async changedBy(commit: string): Promise<string[]> {
    return names(
      await this.#git.run([
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        '-z',
        commit,
      ]),
    );
  }

  #literal(args: readonly string[]): Promise<string> {
    return this.#git.run(['--literal-pathspecs', ...args]);
  }
}

function names(output: string): string[] {
  return output.split('\0').filter(Boolean);
}
