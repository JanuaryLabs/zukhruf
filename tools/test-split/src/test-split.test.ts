import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TemporaryFiles } from '@zukhruf/fs';

const main = fileURLToPath(new URL('main.ts', import.meta.url));

interface Project {
  readonly name: string;
  readonly alone?: boolean;
  readonly command?: string;
}

// The shape that `nx affected -t test --graph=stdout` prints, with a build
// task beside the test tasks as Nx adds one for each dependency.
function taskGraph(projects: readonly Project[]) {
  const command = 'node --test --no-warnings {args}';
  return {
    graph: {
      nodes: Object.fromEntries(
        projects.map((project) => [
          project.name,
          {
            data: {
              targets: {
                test: { options: { command: project.command ?? command } },
              },
            },
          },
        ]),
      ),
    },
    tasks: {
      tasks: Object.fromEntries([
        ...projects.map((project) => [
          `${project.name}:test`,
          {
            target: { project: project.name, target: 'test' },
            parallelism: !(project.alone ?? false),
          },
        ]),
        [
          'async:build',
          { target: { project: 'async', target: 'build' }, parallelism: true },
        ],
      ]),
    },
  };
}

// A task event of an Nx profile: `at` orders the runs, `minutes` is its time.
function event(
  project: string,
  minutes: number,
  { at = 0, status = 'success' }: { at?: number; status?: string } = {},
) {
  return {
    name: `${project}:test`,
    ph: 'X',
    ts: 1_795_000_000_000_000 + at * 3_600_000_000,
    dur: minutes * 60_000_000,
    pid: 1,
    tid: 0,
    args: { target: { project, target: 'test' }, status },
  };
}

// Writes `<run>/<artifact>/.nx/nx-profile.json`, as gh run download lays out
// the artifacts of each run.
async function profiles(
  folder: string,
  runs: Record<string, Record<string, readonly unknown[]>>,
) {
  for (const [run, artifacts] of Object.entries(runs)) {
    for (const [artifact, events] of Object.entries(artifacts)) {
      const directory = join(folder, run, artifact, '.nx');
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'nx-profile.json'),
        JSON.stringify(events),
      );
    }
  }
}

function split(
  graph: ReturnType<typeof taskGraph>,
  folder: string,
  { minutes = 5, machines = 8, parallel = 1 } = {},
) {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      '--no-warnings',
      main,
      '--profiles',
      folder,
      '--minutes',
      String(minutes),
      '--machines',
      String(machines),
      '--parallel',
      String(parallel),
    ],
    { input: JSON.stringify(graph), encoding: 'utf8' },
  );
  assert.equal(status, 0, stderr);
  const output = Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .map((line) => [
        line.slice(0, line.indexOf('=')),
        line.slice(line.indexOf('=') + 1),
      ]),
  );
  const matrix: {
    include: { machine: number; projects: string; shard: string }[];
  } = JSON.parse(output['matrix'] ?? '');
  return { machines: Number(output['machines']), include: matrix.include };
}

test('a node --test task longer than the target is split with --test-shard, one shard on each machine', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('test-split-');
  await profiles(folder.path, {
    '101': { 'test-1': [event('nx', 8), event('async', 1)] },
  });

  // Act
  const plan = split(
    taskGraph([{ name: 'nx' }, { name: 'async' }]),
    folder.path,
  );

  // Assert
  assert.deepStrictEqual(plan, {
    machines: 3,
    include: [
      { machine: 1, projects: 'nx', shard: '1/2' },
      { machine: 2, projects: 'nx', shard: '2/2' },
      { machine: 3, projects: 'async', shard: '' },
    ],
  });
});

test('a long task whose target is not node --test stays whole', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('test-split-');
  await profiles(folder.path, { '101': { 'test-1': [event('ui', 8)] } });

  // Act
  const plan = split(
    taskGraph([{ name: 'ui', command: 'vitest run' }]),
    folder.path,
  );

  // Assert
  assert.deepStrictEqual(plan.include, [
    { machine: 1, projects: 'ui', shard: '' },
  ]);
});

test('the plan takes the fewest machines that keep each within the target, and runs every task once', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('test-split-');
  await profiles(folder.path, {
    '101': {
      'test-1': [event('a', 4), event('b', 3), event('c', 2), event('d', 1)],
    },
  });

  // Act
  const plan = split(
    taskGraph([{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }]),
    folder.path,
  );

  // Assert
  assert.deepStrictEqual(plan, {
    machines: 2,
    include: [
      { machine: 1, projects: 'a,d', shard: '' },
      { machine: 2, projects: 'b,c', shard: '' },
    ],
  });
});

test('a task that Nx runs alone adds its whole time to its machine', async () => {
  // Arrange: 4 + max(1, 4 / 3) is over 5 minutes; beside the others it would fit.
  await using folder = await new TemporaryFiles().directory('test-split-');
  await profiles(folder.path, {
    '101': {
      'test-1': [
        event('testing', 4),
        event('a', 1),
        event('b', 1),
        event('c', 1),
        event('d', 1),
      ],
    },
  });

  // Act
  const plan = split(
    taskGraph([
      { name: 'testing', alone: true },
      { name: 'a' },
      { name: 'b' },
      { name: 'c' },
      { name: 'd' },
    ]),
    folder.path,
    { parallel: 3 },
  );

  // Assert
  assert.deepStrictEqual(plan.include, [
    { machine: 1, projects: 'testing', shard: '' },
    { machine: 2, projects: 'a,b,c,d', shard: '' },
  ]);
});

test('the newest run that executed a task gives its time, a result from the cache is no measurement, and shards add up', async () => {
  // Arrange: in the newest run nx came from the cache. Before it, nx ran in
  // two shards of 4 minutes, and before that whole in 2 minutes.
  await using folder = await new TemporaryFiles().directory('test-split-');
  await profiles(folder.path, {
    '103': {
      'test-1': [event('nx', 0, { at: 3, status: 'local-cache' })],
    },
    '102': {
      'test-1': [event('nx', 4, { at: 2 })],
      'test-2': [event('nx', 4, { at: 2 })],
    },
    '101': { 'test-1': [event('nx', 2, { at: 1 })] },
  });

  // Act
  const plan = split(taskGraph([{ name: 'nx' }]), folder.path);

  // Assert
  assert.deepStrictEqual(plan.include, [
    { machine: 1, projects: 'nx', shard: '1/2' },
    { machine: 2, projects: 'nx', shard: '2/2' },
  ]);
});

test('a task with no measurement counts as the average of the measured ones', async () => {
  // Arrange: new counts as 4 minutes, the average of 6 and 2, so it comes
  // before b; as 0 it would come after b, and as 6 or 7 it would need a third
  // machine.
  await using folder = await new TemporaryFiles().directory('test-split-');
  await profiles(folder.path, {
    '101': { 'test-1': [event('a', 6), event('b', 2)] },
  });

  // Act
  const plan = split(
    taskGraph([{ name: 'a' }, { name: 'b' }, { name: 'new' }]),
    folder.path,
    { minutes: 7 },
  );

  // Assert
  assert.deepStrictEqual(plan.include, [
    { machine: 1, projects: 'a', shard: '' },
    { machine: 2, projects: 'new,b', shard: '' },
  ]);
});

test('with no earlier run, each task counts as the target and the plan takes every machine it may', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('test-split-');

  // Act
  const plan = split(
    taskGraph(['a', 'b', 'c', 'd', 'e'].map((name) => ({ name }))),
    join(folder.path, 'no-runs'),
    { machines: 3 },
  );

  // Assert
  assert.deepStrictEqual(
    plan.include.map(({ projects }) => projects),
    ['a,d', 'b,e', 'c'],
  );
});

test('when the shards would need more machines than allowed, each shard is larger', async () => {
  // Arrange: at 5 minutes nx needs four shards; with three machines and one
  // for async, it gets two.
  await using folder = await new TemporaryFiles().directory('test-split-');
  await profiles(folder.path, {
    '101': { 'test-1': [event('nx', 20), event('async', 1)] },
  });

  // Act
  const plan = split(
    taskGraph([{ name: 'nx' }, { name: 'async' }]),
    folder.path,
    { machines: 3 },
  );

  // Assert
  assert.deepStrictEqual(plan.include, [
    { machine: 1, projects: 'nx', shard: '1/2' },
    { machine: 2, projects: 'nx', shard: '2/2' },
    { machine: 3, projects: 'async', shard: '' },
  ]);
});

test('with no affected test task there is no machine', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('test-split-');

  // Act
  const plan = split(taskGraph([]), folder.path);

  // Assert
  assert.deepStrictEqual(plan, { machines: 0, include: [] });
});

test('when no plan within the cap meets the target, the plan whose longest machine is shortest wins, and runs every task once', async () => {
  // Arrange: shaped like the profiles of main. Cutting nx in three, pool and
  // mutex in two leaves one machine for the rest, at 13 minutes. Cutting nx,
  // pool and mutex in two leaves two machines for the rest, and nx's shards of
  // 6.6 minutes are the longest machines; no shard counts and machine count
  // within the cap do better (an exhaustive search of 1 to 4 shards for each
  // of the seven long tasks finds none).
  const long: Record<string, number> = {
    nx: 13.2,
    pool: 8,
    mutex: 7.1,
    'sqlite-queue': 6.1,
    testing: 5.4,
    eslint: 4.9,
    'git-hooks': 4.7,
  };
  const minutes = new Map([
    ...Object.entries(long),
    ...Array.from(
      { length: 36 },
      (_, index) => [`small-${index + 1}`, 0.2] as const,
    ),
  ]);
  await using folder = await new TemporaryFiles().directory('test-split-');
  await profiles(folder.path, {
    '101': {
      'test-1': [...minutes].map(([project, time]) => event(project, time)),
    },
  });

  // Act
  const plan = split(
    taskGraph(
      [...minutes.keys()].map((name) => ({ name, alone: name === 'testing' })),
    ),
    folder.path,
    { parallel: 3 },
  );

  // Assert: a machine of shards takes one piece; a machine of tasks takes
  // testing, which Nx runs alone, and then the longer of its longest other
  // task and their total over 3.
  const times = plan.include.map(({ projects, shard }) => {
    const names = projects.split(',');
    if (shard !== '') {
      return minutes.get(projects)! / Number(shard.split('/')[1]);
    }
    const alone = names.filter((name) => name === 'testing');
    const shared = names.filter((name) => name !== 'testing');
    return (
      alone.reduce((sum, name) => sum + minutes.get(name)!, 0) +
      Math.max(
        ...shared.map((name) => minutes.get(name)!),
        shared.reduce((sum, name) => sum + minutes.get(name)!, 0) / 3,
      )
    );
  });
  const longest = Math.max(...times);
  assert.equal(
    Math.round(longest * 100) / 100,
    6.6,
    `longest machine ${longest} min: ${JSON.stringify(plan.include)}`,
  );
  const runs = Map.groupBy(
    plan.include.flatMap(({ projects, shard }) =>
      projects.split(',').map((project) => ({ project, shard })),
    ),
    ({ project }) => project,
  );
  assert.deepStrictEqual(
    [...runs.keys()].toSorted(),
    [...minutes.keys()].toSorted(),
  );
  for (const [project, entries] of runs) {
    const shards = entries.map(({ shard }) => shard);
    const count = shards[0] === '' ? 1 : Number(shards[0]!.split('/')[1]);
    assert.deepStrictEqual(
      shards,
      count === 1
        ? ['']
        : Array.from({ length: count }, (_, index) => `${index + 1}/${count}`),
      project,
    );
  }
});
