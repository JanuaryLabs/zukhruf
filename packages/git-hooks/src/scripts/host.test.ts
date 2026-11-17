import assert from 'node:assert/strict';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { repository as commitRepository } from '../testing/pre-commit-repository.ts';
import { repository as pushRepository } from '../testing/pre-push-repository.ts';

// A tool that gives the environment that it got, as JSON on its standard
// output. A test puts it where nx is.
const printEnvironment =
  '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.env));\n';

interface Environments {
  readonly hook: Readonly<Record<string, string>>;
  readonly tool: Readonly<Record<string, string>>;
}

function environments(stderr: string): Environments {
  const line = /^env\s+(\{.*\})$/m.exec(stderr);
  assert.ok(line, `The hook must print the environments:\n${stderr}`);
  const value: unknown = JSON.parse(line[1] ?? '');
  assert.ok(isEnvironments(value), `not the environments: ${stderr}`);
  return value;
}

function isEnvironments(value: unknown): value is Environments {
  return (
    typeof value === 'object' &&
    value !== null &&
    'hook' in value &&
    isEnvironment(value.hook) &&
    'tool' in value &&
    isEnvironment(value.tool)
  );
}

function isEnvironment(
  value: unknown,
): value is Readonly<Record<string, string>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

// The hook environment without each variable that git lists as tied to the
// repo, as git itself gives the list.
async function withoutLocalEnvVars(
  git: (...args: string[]) => Promise<string>,
  hook: Readonly<Record<string, string>>,
) {
  const names = new Set(
    (await git('rev-parse', '--local-env-vars')).split('\n'),
  );
  return Object.fromEntries(
    Object.entries(hook).filter(([name]) => !names.has(name)),
  );
}

test('a tool that a pre-push step runs in a snapshot gets the hook environment without the git variables of the repo, with the nx settings of the snapshot', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await pushRepository(
    folder.path,
    `import { type Push, Step, prePush } from '@zukhruf/git-hooks';
class Show extends Step<Push> {
  readonly name = 'env';
  async run(push: Push) {
    const [update] = push.updates;
    if (update === undefined || update.kind === 'delete') return this.fail('no head');
    const snapshot = await push.snapshot(update.head, { packages: true });
    const tool: unknown = JSON.parse((await snapshot.bin('nx', ['show'])).stdout);
    return this.pass(JSON.stringify({ hook: process.env, tool }));
  }
}
await prePush([new Show()]);
`,
  );
  await repo.write('.gitignore', 'node_modules\n');
  // A lockfile with no dependency, and an install of it.
  await repo.write(
    'package-lock.json',
    `${JSON.stringify({ name: 'probe', lockfileVersion: 3, requires: true, packages: { '': { name: 'probe' } } })}\n`,
  );
  await repo.write(
    'node_modules/.package-lock.json',
    `${JSON.stringify({ name: 'probe', lockfileVersion: 3, requires: true, packages: {} })}\n`,
  );
  await repo.write('node_modules/.bin/nx', printEnvironment);
  await chmod(join(repo.root, 'node_modules/.bin/nx'), 0o755);
  await repo.commit('first');

  // Act
  // With --git-dir and --work-tree, git gives the hook GIT_DIR and
  // GIT_WORK_TREE of the pushing repo.
  const result = await repo.pushWith(
    [`--git-dir=${join(repo.root, '.git')}`, `--work-tree=${repo.root}`],
    '--quiet',
    'origin',
    'main',
  );

  // Assert
  assert.equal(result.code, 0, result.stderr);
  const { hook, tool } = environments(result.stderr);
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE'])
    assert.ok(name in hook, `git must give the hook ${name}`);
  const { NX_CACHE_DIRECTORY, NX_WORKSPACE_DATA_DIRECTORY, ...rest } = tool;
  assert.ok(NX_CACHE_DIRECTORY, 'nx must get the cache of the state folder');
  assert.equal(
    NX_WORKSPACE_DATA_DIRECTORY,
    join(NX_CACHE_DIRECTORY, 'workspace-data'),
  );
  assert.deepEqual(rest, {
    ...(await withoutLocalEnvVars(repo.git, hook)),
    NX_DAEMON: 'false',
  });
});
