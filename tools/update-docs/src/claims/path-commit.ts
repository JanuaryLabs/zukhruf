import { CommitRefused } from '../errors.ts';
import { type Git, GitFailed } from '../git.ts';

/**
 * Commits paths with git's own path commit, `git commit --only`: git builds
 * the commit's index from HEAD and the paths in one process, holds
 * index.lock through the hooks (never --no-verify), and moves HEAD only if
 * HEAD is still the commit it read. A peer's staged file stays staged and out
 * of the commit, and a peer's commit before ours becomes its parent.
 */
export class PathCommit {
  readonly #git: Git;

  constructor(git: Git) {
    this.#git = git;
  }

  /** The new commit's sha; on a refusal the paths are unstaged again. */
  async commit(
    paths: readonly string[],
    messages: readonly string[],
  ): Promise<string> {
    let summary: string;
    try {
      // A new file must be in the index for --only to name it; add stages a
      // deletion too.
      await this.#literal(['add', '--', ...paths]);
      summary = await this.#literal([
        'commit',
        '--only',
        ...messages.flatMap((message) => ['-m', message]),
        '--',
        ...paths,
      ]);
    } catch (error) {
      if (error instanceof GitFailed) {
        await this.#literal(['reset', '-q', '--', ...paths]);
        throw new CommitRefused(error.message);
      }
      throw error;
    }
    return this.#sha(summary);
  }

  /**
   * The new commit, from git's own summary line ("[main 1a2b3c4] subject"):
   * HEAD may already name a peer's later commit.
   */
  async #sha(summary: string): Promise<string> {
    const short = /^\[.* ([\da-f]{4,})\] /.exec(summary)?.[1];
    if (short === undefined) {
      throw new TypeError(`git commit printed no summary line: ${summary}`);
    }
    return (
      await this.#git.run(['rev-parse', '--verify', `${short}^{commit}`])
    ).trim();
  }

  #literal(args: readonly string[]): Promise<string> {
    return this.#git.run(['--literal-pathspecs', ...args]);
  }
}
