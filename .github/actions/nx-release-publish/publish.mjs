// Publishes what nx release version versioned, and retries the projects that
// the first run did not publish.
//
// A publish can fail with a Rekor 409 when sigstore retries a tlog entry that
// Rekor already holds (npm/cli#10078, sigstore/sigstore-js#1708), and Nx then
// skips the dependents (zukhruf 0.5.0, 0.6.3, 0.8.26). A second nx release
// publish cannot heal that: npm stages a publish for minutes, so it does not see
// what the first one published, npm answers "Cannot publish over previously
// staged version", which Nx 23.2.1 does not read as published (npm/cli#9889),
// and Nx skips the dependents again. So the retry publishes only the projects
// that the first run did not, in their order among each other. It runs the
// target directly, because nx release publish refuses a part of a fixed release
// group.
//
// Run it from the workspace root as `node --input-type=module - < publish.mjs`:
// nx/release resolves from the workspace's node_modules, and Nx reads the
// script name "-" from process.argv[1].
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { releasePublish } from 'nx/release';

const { release } = JSON.parse(await readFile('nx.json', 'utf8'));
if (!release?.projects) {
  console.error(
    'nx.json must list release.projects: the retry publishes those that the first run did not.',
  );
  process.exit(1);
}

const results = Object.entries(await releasePublish({}));
if (results.every(([, { code }]) => code === 0)) process.exit(0);
const published = results
  .filter(([, { code }]) => code === 0)
  .map(([project]) => project);
const retry = spawnSync(
  'npx',
  [
    'nx',
    'run-many',
    '-t',
    'nx-release-publish',
    '--outputStyle=static',
    '--excludeTaskDependencies',
    `--projects=${[release.projects].flat().join(',')}`,
    ...(published.length > 0 ? [`--exclude=${published.join(',')}`] : []),
  ],
  { stdio: 'inherit' },
);
process.exit(retry.status ?? 1);
