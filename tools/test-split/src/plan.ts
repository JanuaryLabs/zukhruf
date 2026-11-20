// Deals the affected test tasks to machines by their measured time.
//
// A machine runs one nx command. Nx runs `parallel` tasks at once there, and a
// task with `parallelism: false` with no other task beside it, so a machine
// takes the time of its lone tasks one after another, and then the longer of
// its longest other task and their total over `parallel`. The durations come
// from runs that executed the same `parallel` tasks at once, so they already
// hold that sharing.
//
// A task longer than the target, whose target is `node --test`, is split with
// `--test-shard=i/k` into k pieces, each on a machine of its own: one nx
// command cannot give a flag to one task only. The plan takes the fewest
// machines that keep each within the target. When no plan within the cap does,
// it takes the one whose longest machine is the shortest, so that the machines
// finish together.

export interface Task {
  readonly project: string;
  /** Nx runs it with no other task beside it (`parallelism: false`). */
  readonly alone: boolean;
  /** Its target runs `node --test`, which takes `--test-shard`. */
  readonly shardable: boolean;
}

export interface Options {
  /** The test time that one machine should take, in milliseconds. */
  readonly target: number;
  /** The most machines a plan takes. */
  readonly machines: number;
  /** The tasks that Nx runs at once on one machine (NX_PARALLEL). */
  readonly parallel: number;
}

export type Machine =
  | {
      readonly kind: 'shard';
      readonly project: string;
      readonly shard: string;
      readonly duration: number;
    }
  | {
      readonly kind: 'tasks';
      readonly tasks: readonly Weighed[];
      readonly duration: number;
    };

interface Weighed {
  readonly task: Task;
  readonly duration: number;
}

/**
 * One event of the Chrome trace that Nx writes to NX_PROFILE: `ph` 'X' is a
 * task, `dur` its time in microseconds, `args.status` how it ended.
 */
export interface TraceEvent {
  readonly ph: string;
  readonly ts: number;
  readonly dur?: number;
  readonly args?: {
    readonly target?: { readonly project: string; readonly target: string };
    readonly status?: string;
  };
}

/**
 * The time of each project's test task, in milliseconds, from the newest run
 * that executed it. A run is the events of all its machines' profiles, so the
 * shards of one task add up. A result that came from the cache is no
 * measurement: the task of a run counts only when each of its events is a
 * 'success'.
 */
export function measured(
  runs: readonly (readonly TraceEvent[])[],
  target: string,
): Map<string, number> {
  const newestFirst = runs.toSorted((a, b) => newest(b) - newest(a));
  const durations = new Map<string, number>();
  for (const events of newestFirst) {
    const byProject = Map.groupBy(
      events.filter(
        (event) => event.ph === 'X' && event.args?.target?.target === target,
      ),
      (event) => event.args?.target?.project ?? '',
    );
    for (const [project, tasks] of byProject) {
      if (
        !durations.has(project) &&
        tasks.every((event) => event.args?.status === 'success')
      ) {
        durations.set(
          project,
          tasks.reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000,
        );
      }
    }
  }
  return durations;
}

function newest(events: readonly TraceEvent[]) {
  return Math.max(...events.map((event) => event.ts));
}

/**
 * The machines for the tasks. A task with no measurement counts as the
 * average of the measured ones, and as the target when nothing was measured.
 */
export function plan(
  tasks: readonly Task[],
  durations: ReadonlyMap<string, number>,
  options: Options,
): Machine[] {
  if (tasks.length === 0) {
    return [];
  }
  const known = [...durations.values()];
  const average =
    known.length === 0
      ? options.target
      : known.reduce((sum, duration) => sum + duration, 0) / known.length;
  const weighed = tasks
    .map((task) => ({
      task,
      duration: Math.round(durations.get(task.project) ?? average),
    }))
    .toSorted(
      (a, b) =>
        b.duration - a.duration || a.task.project.localeCompare(b.task.project),
    );

  // A piece size cuts each longer node --test task into the fewest shards that
  // keep its pieces within that size. The sizes at which some task takes one
  // shard more give every distinct cut.
  const sizes = new Set([
    options.target,
    ...weighed.flatMap(({ duration }) =>
      Array.from({ length: options.machines }, (_, index) =>
        Math.ceil(duration / (index + 1)),
      ),
    ),
  ]);
  const candidates = [...sizes]
    .toSorted((a, b) => a - b)
    .flatMap((size) => {
      const split = cut(weighed, size, options.machines);
      const fewest = split.shards.length + (split.whole.length > 0 ? 1 : 0);
      return Array.from(
        { length: Math.max(0, options.machines - fewest + 1) },
        (_, n) => {
          const machines = deal(split, fewest + n, options.parallel);
          return {
            machines,
            shards: split.shards.length,
            longest: Math.max(...machines.map(({ duration }) => duration)),
          };
        },
      );
    });
  if (candidates.length === 0) {
    throw new Error(
      `No split of ${weighed.length} tasks fits ${options.machines} machines`,
    );
  }

  const within = candidates.filter(({ longest }) => longest <= options.target);
  const [best] =
    within.length > 0
      ? within.toSorted(
          (a, b) =>
            a.machines.length - b.machines.length ||
            a.shards - b.shards ||
            a.longest - b.longest,
        )
      : candidates.toSorted(
          (a, b) =>
            a.longest - b.longest ||
            a.machines.length - b.machines.length ||
            a.shards - b.shards,
        );
  return best!.machines;
}

function cut(weighed: readonly Weighed[], size: number, machines: number) {
  const long = (entry: Weighed) =>
    entry.task.shardable && entry.duration > size;
  return {
    shards: weighed.filter(long).flatMap(({ task, duration }) => {
      const count = Math.min(Math.ceil(duration / size), machines);
      return Array.from({ length: count }, (_, index): Machine => ({
        kind: 'shard',
        project: task.project,
        shard: `${index + 1}/${count}`,
        duration: duration / count,
      }));
    }),
    whole: weighed.filter((entry) => !long(entry)),
  };
}

// Longest first, each task to the machine that it lengthens least.
function deal(
  { shards, whole }: ReturnType<typeof cut>,
  machines: number,
  parallel: number,
): Machine[] {
  const bins = Array.from(
    { length: machines - shards.length },
    (): Weighed[] => [],
  );
  for (const entry of whole) {
    const after = bins.map((bin) => time([...bin, entry], parallel));
    bins[after.indexOf(Math.min(...after))]!.push(entry);
  }
  return [
    ...shards,
    ...bins
      .filter((bin) => bin.length > 0)
      .map((bin): Machine => ({
        kind: 'tasks',
        tasks: bin,
        duration: time(bin, parallel),
      })),
  ];
}

function time(bin: readonly Weighed[], parallel: number) {
  const alone = bin.filter(({ task }) => task.alone);
  const shared = bin.filter(({ task }) => !task.alone);
  return (
    alone.reduce((sum, { duration }) => sum + duration, 0) +
    Math.max(
      0,
      ...shared.map(({ duration }) => duration),
      shared.reduce((sum, { duration }) => sum + duration, 0) / parallel,
    )
  );
}
