// The nightly upgrade check of @zukhruf/nx (packages/nx ADR 0020): a
// workspace made with an older published version and moved to `latest` with
// `nx migrate` must have the Nx configuration of a workspace made with
// `latest`. A difference is a change of generated output that shipped without
// its migration (packages/nx ADR 0017). The `e2e:upgrade` target runs it.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TemporaryFiles, isErrno } from '@zukhruf/fs';

import {
  StepFailed,
  generateWorkspace,
  latestVersion,
  read,
  step,
} from './generated-workspace.ts';

// The oldest release the check starts from. 8d8bd7ff added auth, the last
// generator that generateWorkspace runs (release/0.8.36). The presets of
// 0.8.45 to 0.8.58 pin eslint-plugin-unicorn 79.0.0 under the ^80.0.0 peer of
// their @zukhruf/eslint, so their install stops with ERESOLVE; 109a502b fixed
// the pin in 0.8.59 (seen on 2026-11-22 with bases 0.8.52 and 0.8.58).
const oldestBase = '0.8.59';

// A release a day old has had a day of use: the newest such release is the
// one a repo of the standard most likely runs when it moves to latest.
const baseAge = 24 * 60 * 60 * 1000;

// The keys of nx.json that the generators and the migrations write and that
// change what a task runs after.
const nxJsonKeys = ['targetDefaults', 'namedInputs', 'plugins'];

// A command is the repo's to change after the generator wrote it, and no
// migration rewrites one (ADR 0017 decision 4).
const commandKeys = new Set(['command', 'commands']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The record at `key` of `value`, or an error that names the path. */
function recordAt(
  value: Record<string, unknown>,
  key: string,
  what: string,
): Record<string, unknown> {
  const child = value[key];
  if (!isRecord(child)) throw new Error(`${what}.${key} is not an object.`);
  return child;
}

function stringAt(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} is not a string.`);
  return value;
}

/**
 * The newest release published more than a day ago, and not older than
 * `oldestBase`. npm 12 prints `npm view --json` as an array with one entry for
 * the one package asked.
 */
function baseVersion(cwd: string): string {
  const printed: unknown = JSON.parse(
    read('npm', ['view', '@zukhruf/nx', 'time', '--json'], cwd),
  );
  if (
    !Array.isArray(printed) ||
    printed.length !== 1 ||
    !isRecord(printed[0])
  ) {
    throw new Error('npm view @zukhruf/nx time --json printed another shape.');
  }
  // `created` and `modified` are not versions, and a version with a `-` is a
  // prerelease that `latest` never names.
  const releases = Object.entries(printed[0])
    .filter(([key]) => /^\d+\.\d+\.\d+$/.test(key))
    .map(([version, time]) => ({
      version,
      published: Date.parse(stringAt(time, version)),
    }))
    .toSorted((a, b) => b.published - a.published);
  const oldest = releases.find(({ version }) => version === oldestBase);
  if (oldest === undefined) {
    throw new Error(`npm has no @zukhruf/nx@${oldestBase}.`);
  }
  // A day after a release the newest such release is past the oldest base;
  // until then the oldest base is the newest release the check can start from.
  const base = releases.find(
    ({ published }) => published < Date.now() - baseAge,
  );
  return base === undefined || base.published < oldest.published
    ? oldest.version
    : base.version;
}

/** Each leaf of `value` at its path, with the command keys left out. */
function leaves(value: unknown, path: string, into: Map<string, string>) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      leaves(item, `${path}[${index}]`, into);
    }
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (!commandKeys.has(key)) leaves(item, `${path}.${key}`, into);
    }
  } else if (value !== undefined) {
    into.set(path, JSON.stringify(value));
  }
  return into;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isRecord(value)) throw new Error(`${path} is not a JSON object.`);
  return value;
}

/** project.json of a project root. A project of the standard may have none. */
async function projectJson(path: string): Promise<unknown> {
  try {
    return await readJson(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

/** What the check compares of one workspace, as paths and their values. */
async function configuration(root: string): Promise<Map<string, string>> {
  const compared = new Map<string, string>();
  const nxJson = await readJson(join(root, 'nx.json'));
  for (const key of nxJsonKeys) leaves(nxJson[key], `nx.json ${key}`, compared);

  // Nx writes each graph to a file: a workspace's task graph is larger than
  // the 1 MiB that execFileSync takes from stdout (ENOBUFS, 2026-11-22).
  const projectGraph = join(root, '..', 'project-graph.json');
  step(
    'Write the project graph',
    'npx',
    ['nx', 'graph', `--file=${projectGraph}`],
    root,
  );
  const projects = recordAt(
    recordAt(await readJson(projectGraph), 'graph', 'nx graph'),
    'nodes',
    'nx graph.graph',
  );
  const targets = new Set<string>();
  for (const project of Object.keys(projects)) {
    const data = recordAt(
      recordAt(projects, project, 'nodes'),
      'data',
      project,
    );
    const projectRoot = stringAt(data['root'], `${project} root`);
    compared.set(`project ${project}`, projectRoot);
    for (const target of Object.keys(recordAt(data, 'targets', project))) {
      targets.add(target);
    }
    const manifest = await readJson(join(root, projectRoot, 'package.json'));
    leaves(manifest['nx'], `${project} package.json nx`, compared);
    leaves(
      await projectJson(join(root, projectRoot, 'project.json')),
      `${project} project.json`,
      compared,
    );
  }

  const taskGraph = join(root, '..', 'task-graph.json');
  step(
    'Write the task graph of every target',
    'npx',
    ['nx', 'run-many', '-t', ...targets, `--graph=${taskGraph}`],
    root,
  );
  const tasks = recordAt(
    recordAt(await readJson(taskGraph), 'tasks', 'nx run-many --graph'),
    'dependencies',
    'nx run-many --graph tasks',
  );
  for (const [task, dependencies] of Object.entries(tasks)) {
    compared.set(`task ${task}`, 'a task');
    if (!Array.isArray(dependencies)) {
      throw new Error(`The dependencies of ${task} are not a list.`);
    }
    // Nx 24 writes each dependency as { id }.
    for (const dependency of dependencies) {
      const what = `a dependency of ${task}`;
      if (!isRecord(dependency)) throw new Error(`${what} is not an object.`);
      compared.set(
        `task ${task} -> ${stringAt(dependency['id'], what)}`,
        'an edge',
      );
    }
  }
  return compared;
}

async function nxVersion(root: string): Promise<string> {
  const path = join(root, 'node_modules/nx/package.json');
  return stringAt((await readJson(path))['version'], `${path} version`);
}

await using baseFolder = await new TemporaryFiles().directory(
  'zukhruf-nx-upgrade-base-',
);
await using latestFolder = await new TemporaryFiles().directory(
  'zukhruf-nx-upgrade-latest-',
);
// Both sides get the one version, also when a release lands during the run.
const latest = latestVersion(baseFolder.path);
const base = baseVersion(baseFolder.path);
try {
  const upgraded = generateWorkspace(baseFolder.path, base);
  step(
    `Move the workspace of ${base} to ${latest}`,
    'npx',
    ['nx', 'migrate', `@zukhruf/nx@${latest}`],
    upgraded,
  );
  step('Install the moved versions', 'npm', ['install'], upgraded);
  // Nx writes migrations.json only when a migration is in the range, and
  // --if-exists runs nothing without it. --agentic=false keeps a run inside an
  // AI agent the same as in CI.
  step(
    'Run the migrations',
    'npx',
    ['nx', 'migrate', '--run-migrations', '--if-exists', '--agentic=false'],
    upgraded,
  );
  const fresh = generateWorkspace(latestFolder.path, latest);

  const [upgradedNx, freshNx] = await Promise.all([
    nxVersion(upgraded),
    nxVersion(fresh),
  ]);
  if (upgradedNx !== freshNx) {
    console.error(
      `\nThe upgraded workspace runs nx ${upgradedNx}, and a fresh one runs nx ${freshNx}. The migrations of @zukhruf/nx do not move nx to the version its generators write (packages/nx docs/adr/0017).`,
    );
    process.exitCode = 1;
  } else {
    const [before, after] = await Promise.all([
      configuration(upgraded),
      configuration(fresh),
    ]);
    const paths = [...new Set([...before.keys(), ...after.keys()])].toSorted();
    const differences = paths.filter(
      (path) => before.get(path) !== after.get(path),
    );
    for (const path of differences) {
      console.error(
        `${path}\n  upgraded from ${base}: ${before.get(path) ?? '(none)'}\n  fresh ${latest}:     ${after.get(path) ?? '(none)'}`,
      );
    }
    if (differences.length > 0) {
      console.error(
        `\n${differences.length} differences between @zukhruf/nx@${base} moved to ${latest} and a fresh ${latest}. A change of generated output shipped without its migration (packages/nx docs/adr/0017): write the migration that brings it.`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        `\nThe upgrade check passed: @zukhruf/nx@${base} moved to ${latest} has the Nx configuration of a fresh ${latest} (nx ${freshNx}).`,
      );
    }
  }
} catch (error) {
  if (!(error instanceof StepFailed)) throw error;
  console.error(`\nThe upgrade check failed at a step. ${error.message}`);
  process.exitCode = 1;
}
