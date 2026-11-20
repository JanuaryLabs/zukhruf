// Plans the test machines of a CI run. Pipe it the task graph of the tasks to
// split, and give it the Nx profiles of earlier runs, one folder per run:
//
//   npx nx affected -t test --graph=stdout |
//     node tools/test-split/src/main.ts --profiles <dir> --minutes 5 --machines 8 --parallel 3
//
// It prints `matrix=<json>` and `machines=<count>` for GITHUB_OUTPUT, and the
// plan to stderr. Each entry of the matrix has `projects`, for
// `nx run-many -t test --projects`, and `shard`, empty or the `i/k` of
// `--test-shard` for its one project.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { parseArgs } from 'node:util';

import { type Task, type TraceEvent, measured, plan } from './plan.ts';

const target = 'test';

const { values } = parseArgs({
  options: {
    profiles: { type: 'string' },
    minutes: { type: 'string' },
    machines: { type: 'string' },
    parallel: { type: 'string' },
  },
});

const options = {
  target: positive('minutes') * 60_000,
  machines: Math.floor(positive('machines')),
  parallel: Math.floor(positive('parallel')),
};
const profiles = values.profiles;
if (profiles === undefined) {
  throw new Error('--profiles is required: a folder with one folder per run');
}

interface TaskGraphOutput {
  readonly graph: {
    readonly nodes: Record<
      string,
      {
        readonly data: {
          readonly targets: Record<
            string,
            { readonly options?: { readonly command?: string } }
          >;
        };
      }
    >;
  };
  readonly tasks: {
    readonly tasks: Record<
      string,
      {
        readonly target: { readonly project: string; readonly target: string };
        readonly parallelism: boolean;
      }
    >;
  };
}

const { graph, tasks }: TaskGraphOutput = JSON.parse(await text(process.stdin));
const testTasks: Task[] = Object.values(tasks.tasks)
  .filter((task) => task.target.target === target)
  .map(({ target: { project }, parallelism }) => ({
    project,
    alone: !parallelism,
    shardable: /^node --test\b/.test(
      graph.nodes[project]?.data.targets[target]?.options?.command ?? '',
    ),
  }));

const durations = measured(await runs(profiles), target);
const machines = plan(testTasks, durations, options);

for (const [index, machine] of machines.entries()) {
  const names =
    machine.kind === 'shard'
      ? `${machine.project} (shard ${machine.shard})`
      : machine.tasks
          .map(
            ({ task, duration }) =>
              `${task.project} ${minutes(duration)}${durations.has(task.project) ? '' : ' (not measured)'}`,
          )
          .join(', ');
  console.error(
    `Machine ${index + 1}: ${minutes(machine.duration)} min: ${names}`,
  );
}

const include = machines.map((machine, index) => ({
  machine: index + 1,
  projects:
    machine.kind === 'shard'
      ? machine.project
      : machine.tasks.map(({ task }) => task.project).join(','),
  shard: machine.kind === 'shard' ? machine.shard : '',
}));
process.stdout.write(
  `matrix=${JSON.stringify({ include })}\nmachines=${include.length}\n`,
);

function positive(name: 'minutes' | 'machines' | 'parallel') {
  const value = Number(values[name]);
  if (!(value > 0)) {
    throw new Error(`--${name} must be a number above 0, got ${values[name]}`);
  }
  return value;
}

function minutes(milliseconds: number) {
  return (milliseconds / 60_000).toFixed(1);
}

// One folder per run, holding its artifacts. No folder means no earlier run.
async function runs(folder: string): Promise<TraceEvent[][]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (Error.isError(error) && 'code' in error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    },
  );
  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const run = join(folder, entry.name);
        const files = (await readdir(run, { recursive: true })).filter(
          (file) =>
            file === 'nx-profile.json' || file.endsWith('/nx-profile.json'),
        );
        const traces = await Promise.all(
          files.map(async (file) => {
            const events: TraceEvent[] = JSON.parse(
              await readFile(join(run, file), 'utf8'),
            );
            return events;
          }),
        );
        return traces.flat();
      }),
  );
}
