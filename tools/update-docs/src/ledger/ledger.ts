import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { LedgerCorrupt } from '../errors.ts';
import type { BlockedItem, OpenItem, QueuedCandidate } from './items.ts';
import { Items } from './items.ts';
import { ROOT, Shape } from './shape.ts';

export interface LedgerCommit {
  readonly sha: string;
  readonly subject: string;
  /** The commit's committer date. */
  readonly at: string;
}

/**
 * A project that a run finished for. A project that never ran has no entry,
 * so an entry always has the start of its last run.
 */
export interface ProjectRun {
  readonly lastRun: string;
  readonly commits: readonly LedgerCommit[];
  readonly queued: readonly QueuedCandidate[];
  readonly open: readonly OpenItem[];
  readonly blocked: readonly BlockedItem[];
}

/** What each project's runs did and left, kept between runs. */
export class Ledger {
  readonly #file: string;
  readonly #projects: ReadonlyMap<string, ProjectRun>;

  private constructor(file: string, projects: ReadonlyMap<string, ProjectRun>) {
    this.#file = file;
    this.#projects = projects;
  }

  /** The ledger at file; before the first run there is none, so it is empty. */
  static async read(file: string): Promise<Ledger> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (Error.isError(error) && 'code' in error && error.code === 'ENOENT') {
        return new Ledger(file, new Map());
      }
      throw error;
    }
    const shape = new Shape(
      (path, problem) => new LedgerCorrupt(file, path, problem),
    );
    const items = new Items(shape);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new LedgerCorrupt(file, 'the document', error.message);
      }
      throw error;
    }
    const projects = shape.record(
      shape.object(value, ROOT, ['projects']).get('projects'),
      'projects',
    );
    return new Ledger(
      file,
      new Map(
        Object.entries(projects).map(([name, value]) => {
          const at = `projects.${name}`;
          const run = shape.object(value, at, [
            'lastRun',
            'commits',
            'queued',
            'open',
            'blocked',
          ]);
          return [
            name,
            {
              lastRun: shape.instant(run.get('lastRun'), `${at}.lastRun`),
              commits: shape.list(
                run.get('commits'),
                `${at}.commits`,
                (each, p) => {
                  const commit = shape.object(each, p, [
                    'sha',
                    'subject',
                    'at',
                  ]);
                  return {
                    sha: shape.text(commit.get('sha'), `${p}.sha`),
                    subject: shape.text(commit.get('subject'), `${p}.subject`),
                    at: shape.instant(commit.get('at'), `${p}.at`),
                  };
                },
              ),
              queued: items.queued(run.get('queued'), `${at}.queued`),
              open: items.open(run.get('open'), `${at}.open`),
              blocked: items.blocked(run.get('blocked'), `${at}.blocked`),
            },
          ];
        }),
      ),
    );
  }

  /** The projects a run finished for, by name. */
  get runs(): ReadonlyMap<string, ProjectRun> {
    return this.#projects;
  }

  /**
   * The ledger after a run: its commits are added, and its queued, open and
   * blocked items replace the earlier ones, so a watched run that wrote a
   * queued candidate drops it.
   */
  finished(project: string, run: ProjectRun): Ledger {
    const before = this.#projects.get(project);
    return new Ledger(
      this.#file,
      new Map([
        ...this.#projects,
        [
          project,
          {
            lastRun: run.lastRun,
            commits: [...(before?.commits ?? []), ...run.commits],
            queued: run.queued,
            open: run.open,
            blocked: run.blocked,
          },
        ],
      ]),
    );
  }

  /** Writes a temporary file beside the ledger, then renames it over it. */
  async write(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    const temporary = join(dirname(this.#file), `.ledger-${randomUUID()}.json`);
    const projects = Object.fromEntries(
      [...this.#projects].toSorted(([a], [b]) => a.localeCompare(b)),
    );
    await writeFile(temporary, `${JSON.stringify({ projects }, null, 2)}\n`);
    await rename(temporary, this.#file);
  }
}
