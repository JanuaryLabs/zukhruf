import { glob, open, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import type { ClaudeHome } from '../claude-home.ts';
import { type Git, GitFailed } from '../git.ts';
import { under } from '../paths.ts';
import type { Since } from '../since.ts';
import type { Project } from '../workspace/project.ts';
import { TEXT_EXCERPT, excerpt } from './excerpt.ts';
import type { ConsumerCommitRecord, ConsumerSiteRecord } from './record.ts';

const SITES_PER_REPO = 20;
const CWD = /"cwd":"((?:[^"\\]|\\.)*)"/;
const FIELD = '\u{1f}';

/**
 * The git repositories on this machine that may consume the workspace's
 * packages: the folders Claude Code sessions ran in, found from their
 * transcripts, never from a list.
 */
export class ConsumerRepos {
  readonly #claude: ClaudeHome;
  readonly #workspace: Git;

  constructor(claude: ClaudeHome, workspace: Git) {
    this.#claude = claude;
    this.#workspace = workspace;
  }

  async discover(): Promise<ConsumerRepo[]> {
    const excluded = await this.#excluded();
    const workspace = await realpath(this.#workspace.directory);
    const outside = (path: string) =>
      !this.#claude.holds(path) &&
      !excluded.some((prefix) => under(path, prefix));
    const cwds = new Set<string>();
    for await (const file of glob('*/*.jsonl', {
      cwd: this.#claude.projects,
    })) {
      const cwd = await this.#cwd(join(this.#claude.projects, file));
      if (cwd !== undefined && outside(cwd)) {
        cwds.add(cwd);
      }
    }
    const tops = new Set<string>();
    for (const cwd of cwds) {
      try {
        tops.add(
          (
            await this.#workspace.at(cwd).run(['rev-parse', '--show-toplevel'])
          ).trim(),
        );
      } catch (error) {
        if (!(error instanceof GitFailed)) {
          throw error;
        }
      }
    }
    return [...tops]
      .filter((top) => top !== workspace && outside(top))
      .toSorted()
      .map((top) => new ConsumerRepo(this.#workspace.at(top)));
  }

  /** The prefixes the user excluded; no config file means none. */
  async #excluded(): Promise<string[]> {
    const file = join(this.#claude.state, 'config.json');
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }
    const value: unknown = JSON.parse(text);
    if (
      typeof value === 'object' &&
      value !== null &&
      'exclude' in value &&
      Array.isArray(value.exclude) &&
      value.exclude.every((prefix: unknown) => typeof prefix === 'string')
    ) {
      return value.exclude.filter(
        (prefix: unknown): prefix is string => typeof prefix === 'string',
      );
    }
    throw new TypeError(`${file} must be {"exclude": ["/absolute/prefix"]}`);
  }

  /** The first cwd a transcript records, read from its head only. */
  async #cwd(file: string): Promise<string | undefined> {
    await using handle = await open(file);
    const chunk = Buffer.alloc(64 * 1024);
    let head = '';
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length);
      if (bytesRead === 0) {
        return undefined;
      }
      head += chunk.toString('utf8', 0, bytesRead);
      const match = CWD.exec(head);
      if (match?.[1] !== undefined) {
        const cwd: unknown = JSON.parse(`"${match[1]}"`);
        return typeof cwd === 'string' ? cwd : undefined;
      }
    }
  }
}

/** A git repository that may declare some of the workspace's packages. */
export class ConsumerRepo {
  readonly path: string;
  readonly #git: Git;

  constructor(git: Git) {
    this.path = git.directory;
    this.#git = git;
  }

  /** The npm names a tracked package.json of the repo declares. */
  async declares(npmNames: readonly string[]): Promise<Set<string>> {
    const found = await this.#git.grep([
      '-h',
      '-o',
      '-F',
      ...npmNames.flatMap((name) => ['-e', `"${name}"`]),
      '--',
      '*package.json',
    ]);
    return new Set(
      found
        .split('\n')
        .filter(Boolean)
        .map((quoted) => quoted.slice(1, -1)),
    );
  }

  /** The lines that name the package today, outside the manifests. */
  async sites(project: Project): Promise<ConsumerSiteRecord[]> {
    const ts = (await this.#git.run(['log', '-1', '--format=%cI'])).trim();
    const found = await this.#git.grep([
      '-n',
      '-I',
      '-F',
      '-e',
      project.npmName,
      '--',
      ':!*package.json',
      ':!package-lock.json',
    ]);
    return found
      .split('\n')
      .filter(Boolean)
      .slice(0, SITES_PER_REPO)
      .map((line) => {
        const [file = '', number = '', ...text] = line.split(':');
        return {
          source: 'consumer-site',
          ts,
          ref: `${this.path}/${file}:${number}`,
          text: excerpt(text.join(':'), project.needles, TEXT_EXCERPT),
          repo: this.path,
        };
      });
  }

  /** The commits since a start that add or remove a line naming the package. */
  async commits(
    project: Project,
    since: Since,
  ): Promise<ConsumerCommitRecord[]> {
    const log = await this.#git.run([
      'log',
      ...since.gitArgs(),
      `-G${project.npmName.replaceAll(/[.[\]*^$\\]/g, '\\$&')}`,
      `--format=%H${FIELD}%cI${FIELD}%s`,
    ]);
    return log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha = '', ts = '', subject = ''] = line.split(FIELD);
        return {
          source: 'consumer-commit',
          ts,
          ref: sha,
          text: subject,
          repo: this.path,
        };
      });
  }
}

function isMissing(error: unknown): boolean {
  return Error.isError(error) && 'code' in error && error.code === 'ENOENT';
}
