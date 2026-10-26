import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { MissingLockfileError, type Push } from './push.ts';
import { runNx } from './snapshot/nx.ts';
import { type Outcome, Step } from './step.ts';

interface BuildOptions {
  // The nx targets to run on all projects.
  readonly targets?: readonly string[];
  // The number of tasks that nx runs at the same time.
  readonly parallel?: number;
  // More environment variables for nx, and never for npm: with
  // NODE_ENV=production, npm does not install the devDependencies.
  readonly env?: Readonly<Record<string, string>>;
}

// The lines of error output that a fail shows for each failed task.
const shownLines = 20;

// One task in nx's summary of its last run, `run.json` in the cache folder.
interface Task {
  readonly projectName: string;
  readonly target: string;
  readonly hash: string;
  readonly cacheStatus: string;
  readonly status: number;
}

type Built =
  | { readonly kind: 'built'; readonly line: string }
  | { readonly kind: 'failed'; readonly lines: readonly string[] };

// Builds each pushed commit with the production configuration of nx, in a
// snapshot of the commit, never in the working tree: an edit that is not
// committed is not in the push, so it cannot stop a good push or hide a
// broken one. A commit is built one time, also when the push sends it to more
// than one ref, and only when the remote does not have it.
export class Build extends Step<Push> {
  readonly name = 'build';
  readonly #targets: readonly string[];
  readonly #parallel: number | undefined;
  readonly #env: Readonly<Record<string, string>>;

  constructor({ targets = ['build'], parallel, env = {} }: BuildOptions = {}) {
    super();
    this.#targets = targets;
    this.#parallel = parallel;
    this.#env = env;
  }

  async run(push: Push): Promise<Outcome> {
    const fresh = new Map<string, boolean>();
    for (const update of push.updates)
      if (update.kind !== 'delete')
        fresh.set(
          update.head,
          (fresh.get(update.head) ?? false) || update.base !== update.head,
        );
    if (fresh.size === 0)
      return this.skip('skipped: the push only deletes refs');
    const lines: string[] = [];
    let built = false;
    for (const [head, isNew] of fresh) {
      if (!isNew) {
        lines.push(`skipped: the remote already has ${head.slice(0, 7)}`);
        continue;
      }
      const result = await this.#build(push, head);
      if (result.kind === 'failed')
        return this.fail([...lines, ...result.lines].join('\n'));
      lines.push(result.line);
      built = true;
    }
    return built ? this.pass(lines.join('\n')) : this.skip(lines.join('\n'));
  }

  async #build(push: Push, head: string): Promise<Built> {
    const short = head.slice(0, 7);
    try {
      return await push.inSnapshot(head, async (folder, environment) => {
        const cache = environment.NX_CACHE_DIRECTORY ?? '';
        // A run that ends before its tasks writes no summary, so the summary
        // of an older run must not stay.
        await rm(join(cache, 'run.json'), { force: true });
        const { code, stdout, stderr } = await runNx(
          folder,
          { ...environment, ...this.#env },
          [
            'run-many',
            `--targets=${this.#targets.join(',')}`,
            '--configuration=production',
            ...(this.#parallel === undefined
              ? []
              : [`--parallel=${this.#parallel}`]),
          ],
        );
        const tasks = await lastRun(cache);
        if (code === 0) {
          const projects = new Set(tasks.map((task) => task.projectName));
          const cached = tasks.filter(
            (task) => task.cacheStatus !== 'cache-miss',
          );
          return {
            kind: 'built',
            line: `${short}: built ${projects.size} projects, ${cached.length} of ${tasks.length} tasks from cache`,
          };
        }
        // nx exits with 130 when a task fails, so each code other than 0 is a
        // fail.
        const failed = tasks.filter((task) => task.status !== 0);
        if (failed.length === 0)
          return {
            kind: 'failed',
            lines: [
              `${short}: nx exited with ${code}`,
              ...shown(`${stdout}\n${stderr}`),
            ],
          };
        const lines = [
          `${short}: ${failed.length} of ${tasks.length} tasks failed: ${failed.map(taskName).join(', ')}`,
        ];
        for (const task of failed) {
          if (failed.length > 1) lines.push(`  ${taskName(task)}`);
          const output = await readFile(
            join(cache, 'terminalOutputs', task.hash),
            'utf8',
          ).catch(() => '');
          lines.push(...shown(output, true));
        }
        return { kind: 'failed', lines };
      });
    } catch (error) {
      if (error instanceof MissingLockfileError)
        return {
          kind: 'failed',
          lines: [
            `${short} has no package-lock.json; Build works with npm workspaces`,
          ],
        };
      if (!(error instanceof Error)) throw error;
      return {
        kind: 'failed',
        lines: [`${short}: ${error.message.trimEnd()}`],
      };
    }
  }
}

// Up to 20 lines of output, indented, and the number of the other lines. The
// first line of a task's output is the command that nx echoes.
function shown(output: string, echoed = false): string[] {
  const lines = stripVTControlCharacters(output)
    .split(/\r?\n/)
    .filter(
      (line, index) =>
        line.trim() !== '' && !(echoed && index === 0 && line.startsWith('> ')),
    );
  const more = lines.length - shownLines;
  return [
    ...lines.slice(0, shownLines).map((line) => `  ${line}`),
    ...(more > 0 ? [`  … ${more} more lines`] : []),
  ];
}

async function lastRun(cache: string): Promise<Task[]> {
  let summary: unknown;
  try {
    summary = JSON.parse(await readFile(join(cache, 'run.json'), 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return [];
    throw error;
  }
  const tasks =
    typeof summary === 'object' && summary !== null && 'tasks' in summary
      ? summary.tasks
      : undefined;
  if (!Array.isArray(tasks))
    throw new TypeError(
      `nx wrote a run.json without tasks: ${JSON.stringify(summary)}`,
    );
  return tasks.map((task: unknown) => {
    if (!isTask(task))
      throw new TypeError(
        `nx wrote a task that is not known: ${JSON.stringify(task)}`,
      );
    return task;
  });
}

function isTask(value: unknown): value is Task {
  return (
    typeof value === 'object' &&
    value !== null &&
    'projectName' in value &&
    typeof value.projectName === 'string' &&
    'target' in value &&
    typeof value.target === 'string' &&
    'hash' in value &&
    typeof value.hash === 'string' &&
    'cacheStatus' in value &&
    typeof value.cacheStatus === 'string' &&
    'status' in value &&
    typeof value.status === 'number'
  );
}

// The task as a person runs it: nx's task id also holds the configuration.
function taskName(task: Task): string {
  return `${task.projectName}:${task.target}`;
}
