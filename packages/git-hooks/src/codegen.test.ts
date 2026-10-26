import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/testing/fs';

const execFileAsync = promisify(execFile);
const packageEntry = import.meta.resolve('./index.ts');

// A git repo in a temp folder whose pre-commit hook is `.husky/pre-commit.ts`,
// reached through the committed link `.husky/pre-commit`, as a repo installs
// it. git and the hook see none of the user's git config and no environment
// of the Nx task that runs this test.
async function repository(root: string, hook: string) {
  const environment = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = async (...args: string[]) =>
    (await execFileAsync('git', args, { cwd: root, env: environment })).stdout;
  await git('init', '--quiet', '--initial-branch=main');
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
  await writeFile(join(root, '.prettierrc'), '{ "singleQuote": true }\n');
  await mkdir(join(root, '.husky'));
  await writeFile(
    join(root, '.husky/pre-commit.ts'),
    `#!/usr/bin/env node\n${hook.replaceAll('@zukhruf/git-hooks', packageEntry)}`,
  );
  await chmod(join(root, '.husky/pre-commit.ts'), 0o755);
  await symlink('pre-commit.ts', join(root, '.husky/pre-commit'));
  return {
    root,
    git,
    write: (path: string, content: string) =>
      writeFile(join(root, path), content),
    async commit(message: string, ...gitOptions: string[]) {
      try {
        const { stdout, stderr } = await execFileAsync(
          'git',
          [
            '-c',
            'core.hooksPath=.husky',
            ...gitOptions,
            'commit',
            '--quiet',
            '-m',
            message,
          ],
          { cwd: root, env: environment },
        );
        return { code: 0, stdout, stderr };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          !('stdout' in error) ||
          !('stderr' in error)
        )
          throw error;
        return {
          code: Number(error.code),
          stdout: String(error.stdout),
          stderr: String(error.stderr),
        };
      }
    },
  };
}

const zukhrufModules = new URL('../../../node_modules', import.meta.url)
  .pathname;

// An Nx workspace in the repo with four projects: frontend depends on backend,
// and other and backend-e2e depend on nothing. backend's `openapi` target is a
// real nx:run-commands target that writes openapi.json, the declared output,
// and noise.txt, which no step declares. `openapi-unformatted` writes the
// same spec without Prettier's layout, and `broken` fails. frontend's `client`
// target reads openapi.json and writes client/index.ts, so it works only after
// `openapi`. The base commit is made without the hook.
async function workspace(folder: string, hook: string) {
  const repo = await repository(folder, hook);
  await symlink(zukhrufModules, join(repo.root, 'node_modules'));
  await repo.write('.gitignore', 'node_modules\n.nx\n');
  await repo.write(
    'package.json',
    '{ "name": "probe", "private": true, "type": "module", "workspaces": ["packages/*"] }\n',
  );
  await repo.write('nx.json', '{}\n');
  await mkdir(join(repo.root, 'tools'));
  await repo.write(
    'tools/generate.mjs',
    `import { writeFileSync } from 'node:fs';
const spec = { openapi: '3.1.0' };
writeFileSync('openapi.json', process.argv[2] === 'formatted' ? '{ "openapi": "3.1.0" }\\n' : JSON.stringify(spec));
writeFileSync('noise.txt', 'not an output of any step\\n');
`,
  );
  await repo.write(
    'tools/client.mjs',
    `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const { openapi } = JSON.parse(readFileSync('openapi.json', 'utf8'));
mkdirSync('client', { recursive: true });
writeFileSync('client/index.ts', \`export const openapi = '\${openapi}';\\n\`);
`,
  );
  await repo.write(
    'tools/broken.mjs',
    `console.error('the spec build failed');
process.exit(3);
`,
  );
  const projects = {
    backend: {
      dependencies: {},
      targets: {
        openapi: {
          executor: 'nx:run-commands',
          options: { command: 'node tools/generate.mjs formatted' },
        },
        'openapi-unformatted': {
          executor: 'nx:run-commands',
          options: { command: 'node tools/generate.mjs unformatted' },
        },
        broken: {
          executor: 'nx:run-commands',
          options: { command: 'node tools/broken.mjs' },
        },
      },
    },
    frontend: {
      dependencies: { '@probe/backend': '*' },
      targets: {
        client: {
          executor: 'nx:run-commands',
          options: { command: 'node tools/client.mjs' },
        },
      },
    },
    other: { dependencies: {}, targets: {} },
    'backend-e2e': { dependencies: {}, targets: {} },
  };
  for (const [name, { dependencies, targets }] of Object.entries(projects)) {
    await mkdir(join(repo.root, `packages/${name}/src`), { recursive: true });
    await repo.write(
      `packages/${name}/package.json`,
      `${JSON.stringify({ name: `@probe/${name}`, version: '0.0.0', type: 'module', dependencies, nx: { targets } })}\n`,
    );
    await repo.write(
      `packages/${name}/src/index.ts`,
      'export const value = 1;\n',
    );
  }
  await repo.git('add', '--all');
  await repo.git('commit', '--quiet', '--no-verify', '-m', 'base');
  return repo;
}

const gated = `import { Codegen, preCommit } from '@zukhruf/git-hooks';
await preCommit([
  new Codegen({
    when: ['@probe/backend', '@probe/frontend'],
    run: ['@probe/backend:openapi', '@probe/frontend:client'],
    stage: ['openapi.json', 'client'],
  }),
]);
`;

test('the codegen step runs each of its targets in order when nx says one of its gated projects is affected by the staged files, and stages only its declared outputs', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path, gated);
  // Only frontend is affected: backend does not depend on it.
  await repo.write(
    'packages/frontend/src/index.ts',
    'export const value = 2;\n',
  );
  await repo.git('add', 'packages/frontend/src/index.ts');

  // Act
  const result = await repo.commit('change the frontend');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    await repo.git('show', '--name-only', '--format=', 'HEAD'),
    'client/index.ts\nopenapi.json\npackages/frontend/src/index.ts\n',
    'The commit must hold the spec, the client made from it, and the staged file, and not noise.txt',
  );
  assert.equal(
    await repo.git('status', '--porcelain', '--', 'noise.txt'),
    '?? noise.txt\n',
    'The build wrote noise.txt, and it stays unstaged',
  );
});

test('the codegen step builds nothing when no gated project is affected by the staged files', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path, gated);
  await repo.write('packages/other/src/index.ts', 'export const value = 2;\n');
  await repo.git('add', 'packages/other/src/index.ts');

  // Act
  const result = await repo.commit('change other');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    existsSync(join(repo.root, 'openapi.json')),
    false,
    'The build must not run',
  );
  assert.equal(
    await repo.git('show', '--name-only', '--format=', 'HEAD'),
    'packages/other/src/index.ts\n',
    'The commit must hold only the staged file',
  );
});

test('the codegen step judges the staged files only: a gated project changed in the working tree and not staged builds nothing', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path, gated);
  await repo.write(
    'packages/backend/src/index.ts',
    'export const value = 2;\n',
  );
  await repo.write('packages/other/src/index.ts', 'export const value = 2;\n');
  await repo.git('add', 'packages/other/src/index.ts');

  // Act
  const result = await repo.commit(
    'change other, backend edited but not staged',
  );

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    existsSync(join(repo.root, 'openapi.json')),
    false,
    'The build must not run for an unstaged edit',
  );
});

test('the codegen step matches gated project names exactly: an affected backend-e2e does not trigger a backend gate', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path, gated);
  await repo.write(
    'packages/backend-e2e/src/index.ts',
    'export const value = 2;\n',
  );
  await repo.git('add', 'packages/backend-e2e/src/index.ts');

  // Act
  const result = await repo.commit('change backend-e2e');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    existsSync(join(repo.root, 'openapi.json')),
    false,
    'backend-e2e is not backend',
  );
});

test('the codegen step without a gate builds on every commit', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(
    folder.path,
    `import { Codegen, preCommit } from '@zukhruf/git-hooks';
await preCommit([new Codegen({ run: ['@probe/backend:openapi'], stage: ['openapi.json'] })]);
`,
  );
  await repo.write('packages/other/src/index.ts', 'export const value = 2;\n');
  await repo.git('add', 'packages/other/src/index.ts');

  // Act
  const result = await repo.commit('change other');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    await repo.git('show', '--name-only', '--format=', 'HEAD'),
    'openapi.json\npackages/other/src/index.ts\n',
    'The commit must hold the generated spec',
  );
});

test('a generated file the codegen step staged is checked by the format step after it', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(
    folder.path,
    `import { Codegen, Format, preCommit } from '@zukhruf/git-hooks';
await preCommit([
  new Codegen({ run: ['@probe/backend:openapi-unformatted'], stage: ['openapi.json'] }),
  new Format(),
]);
`,
  );
  await repo.write('packages/other/src/index.ts', 'export const value = 2;\n');
  await repo.git('add', 'packages/other/src/index.ts');

  // Act
  const result = await repo.commit('change other');

  // Assert
  assert.notEqual(result.code, 0, 'The generated spec is not formatted');
  assert.match(
    result.stderr,
    /is not formatted:\n\s+openapi\.json$/m,
    'The format step must list the generated file',
  );
});

test('a codegen target that fails stops the commit with the reason the target gave, and nothing is committed', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(
    folder.path,
    `import { Codegen, preCommit } from '@zukhruf/git-hooks';
await preCommit([new Codegen({ run: ['@probe/backend:broken'], stage: ['openapi.json'] })]);
`,
  );
  await repo.write('packages/other/src/index.ts', 'export const value = 2;\n');
  await repo.git('add', 'packages/other/src/index.ts');

  // Act
  const result = await repo.commit('change other');

  // Assert
  assert.notEqual(result.code, 0, 'The build failed');
  assert.match(
    result.stderr,
    /^codegen\s+\S/m,
    'The codegen step must give the failure as its outcome',
  );
  assert.match(
    result.stderr,
    /the spec build failed/,
    'The hook must show the reason the target gave',
  );
  assert.doesNotMatch(
    result.stderr,
    /node:internal/,
    'The hook must not crash with a stack trace',
  );
  assert.equal(
    await repo.git('rev-list', '--count', 'HEAD'),
    '1\n',
    'Only the base commit may exist',
  );
});

test('a codegen target that runs git init and git config in its own temp folder makes a repo there, and the git config of the committing repo does not change', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  await using task = await new TemporaryFiles().directory('git-hooks-task-');
  const taskRepo = join(task.path, 'repo');
  const repo = await workspace(
    folder.path,
    `import { Codegen, preCommit } from '@zukhruf/git-hooks';
await preCommit([new Codegen({ run: ['@probe/other:git-init'], stage: ['git-init.log'] })]);
`,
  );
  // A target such as a CLI test that makes a repo of its own in a temp folder.
  await repo.write(
    'tools/git-init.mjs',
    `import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const [folder] = process.argv.slice(2);
mkdirSync(folder);
execFileSync('git', ['init', '--quiet'], { cwd: folder });
execFileSync('git', ['config', 'probe.owner', 'task'], { cwd: folder });
writeFileSync('git-init.log', 'ran\\n');
`,
  );
  await repo.write(
    'packages/other/package.json',
    `${JSON.stringify({
      name: '@probe/other',
      version: '0.0.0',
      type: 'module',
      nx: {
        targets: {
          'git-init': {
            executor: 'nx:run-commands',
            options: { command: `node tools/git-init.mjs ${taskRepo}` },
          },
        },
      },
    })}\n`,
  );
  await repo.git('add', 'tools/git-init.mjs', 'packages/other/package.json');
  const config = await readFile(join(repo.root, '.git/config'), 'utf8');

  // Act
  // With --git-dir and --work-tree, git gives the hook GIT_DIR and
  // GIT_WORK_TREE of the committing repo.
  const result = await repo.commit(
    'add a target that runs git in a temp folder',
    `--git-dir=${join(repo.root, '.git')}`,
    `--work-tree=${repo.root}`,
  );

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    await readFile(join(repo.root, '.git/config'), 'utf8'),
    config,
    'The git config of the committing repo must not change',
  );
  assert.equal(
    await repo.git(
      'show',
      '--name-only',
      '--format=',
      'HEAD',
      '--',
      'git-init.log',
    ),
    'git-init.log\n',
    'The hook must stage the output of the target in the commit',
  );
  const inTask = async (...args: string[]) =>
    (await execFileAsync('git', args, { cwd: taskRepo })).stdout.trim();
  assert.equal(
    await inTask('config', '--local', 'probe.owner'),
    'task',
    'git init must make a repo in the temp folder, with the config that the task wrote',
  );
  assert.equal(
    await inTask('rev-parse', '--absolute-git-dir'),
    join(taskRepo, '.git'),
  );
});
