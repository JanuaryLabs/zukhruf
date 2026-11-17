import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { repository } from './testing/pre-commit-repository.ts';

const dockerOnly = `import { DockerfileInstallsFromLockfile, preCommit } from '@zukhruf/git-hooks';
await preCommit([new DockerfileInstallsFromLockfile()]);
`;

test('a staged Dockerfile that runs npm install is stopped, also inside a continuation line and after the flags of RUN, and the hook names each line', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, dockerOnly);
  await mkdir(join(repo.root, 'apps/api'), { recursive: true });
  await repo.write(
    'apps/api/Dockerfile.migration',
    [
      'FROM node:lts-alpine',
      'RUN npm install prisma@7.8.0 dotenv@16.4.7',
      'RUN apt-get update \\',
      '  # the tools of the build',
      '  && npm i',
      'RUN --mount=type=cache,target=/root/.npm npm install',
      '',
    ].join('\n'),
  );
  await repo.git('add', '.');

  // Act
  const result = await repo.commit('install without the lockfile');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(
    result.stderr,
    /apps\/api\/Dockerfile\.migration:2 {2}npm install prisma@7\.8\.0 dotenv@16\.4\.7/,
  );
  assert.match(result.stderr, /apps\/api\/Dockerfile\.migration:3 {2}npm i$/m);
  assert.match(
    result.stderr,
    /apps\/api\/Dockerfile\.migration:6 {2}npm install$/m,
  );
  assert.match(result.stderr, /RUN npm ci/);
});

test('npm ci, npm ci after the flags of RUN, and a global npm install pass', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, dockerOnly);
  await repo.write(
    'Dockerfile',
    [
      'FROM node:lts-alpine',
      'RUN npm install -g npm@latest',
      'COPY package.json package-lock.json ./',
      'RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev',
      'RUN npm ci && npm run build',
      '',
    ].join('\n'),
  );
  await repo.git('add', '.');

  // Act
  const result = await repo.commit('install from the lockfile');

  // Assert
  assert.equal(result.code, 0, result.stderr);
});

test('an install in the exec form, in a heredoc, with yarn and with pnpm is stopped, and a global yarn add passes', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, dockerOnly);
  await repo.write(
    'Dockerfile',
    [
      'FROM node:lts-alpine',
      'RUN ["npm", "install"]',
      'RUN <<EOF',
      'set -e',
      'npm add left-pad',
      'EOF',
      'RUN yarn',
      'RUN pnpm add left-pad',
      'RUN yarn global add serve',
      '',
    ].join('\n'),
  );
  await repo.git('add', '.');

  // Act
  const result = await repo.commit('other forms');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Dockerfile:2 {2}npm install$/m);
  assert.match(result.stderr, /Dockerfile:3 {2}npm add left-pad$/m);
  assert.match(result.stderr, /Dockerfile:7 {2}yarn$/m);
  assert.match(result.stderr, /Dockerfile:8 {2}pnpm add left-pad$/m);
  assert.doesNotMatch(result.stderr, /yarn global add/);
});

test('npm install in a staged file that is not a Dockerfile passes', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, dockerOnly);
  await repo.write('README.md', 'RUN npm install\n');
  await mkdir(join(repo.root, 'docker'));
  await repo.write('docker/entrypoint.sh', 'npm install\n');
  await repo.git('add', '.');

  // Act
  const result = await repo.commit('docs');

  // Assert
  assert.equal(result.code, 0, result.stderr);
});
