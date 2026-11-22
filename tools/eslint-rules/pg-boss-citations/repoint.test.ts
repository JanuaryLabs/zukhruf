import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { hash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { fixtureWorkspace } from './testing/fixture-workspace.ts';

const exec = promisify(execFile);
const REPOINT = join(import.meta.dirname, 'repoint.ts');

// pg-boss 12.39.0 puts three lines after line 2 of manager.js, rewrites line
// 8 and deletes line 10: old lines 3-7 are new lines 6-10, old 9 is new 12,
// old 11-12 are new 13-14, and old 8 and 10 have no line in the new file.
const OLD_MANAGER = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];
const NEW_MANAGER = [
  'one',
  'two',
  'new a',
  'new b',
  'new c',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight, rewritten',
  'nine',
  'eleven',
  'twelve',
];

function portOf(server: Server): number {
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('The registry listens on no port');
  }
  return address.port;
}

const lines = (list: string[]) => list.map((line) => `${line}\n`).join('');

/**
 * A git repository holding a package that pins pg-boss 12.39.0, with 12.39.0
 * installed as npm installs it, and a registry on localhost that serves the
 * tarball of 12.38.2, the version the package's citations name. `sources`
 * are the package's files, committed.
 */
async function bumpedPackage(sources: Record<string, string>) {
  const old = await fixtureWorkspace({
    'package/package.json': JSON.stringify({
      name: 'pg-boss',
      version: '12.38.2',
    }),
    'package/dist/manager.js': lines(OLD_MANAGER),
  });
  await exec('npm', ['pack', '--pack-destination', old.root], {
    cwd: old.path('package'),
  });
  const [tarballName] = (await readdir(old.root)).filter((file) =>
    file.endsWith('.tgz'),
  );
  const tarball = await readFile(old.path(String(tarballName)));
  const integrity = `sha512-${hash('sha512', tarball, 'base64')}`;
  const registry = createServer((request, response) => {
    const port = portOf(registry);
    if (request.url === '/pg-boss') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          name: 'pg-boss',
          'dist-tags': { latest: '12.38.2' },
          versions: {
            '12.38.2': {
              name: 'pg-boss',
              version: '12.38.2',
              dist: {
                tarball: `http://127.0.0.1:${port}/pg-boss.tgz`,
                integrity,
              },
            },
          },
        }),
      );
    } else if (request.url === '/pg-boss.tgz') {
      response.end(tarball);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((listening) =>
    registry.listen(0, '127.0.0.1', listening),
  );
  const port = portOf(registry);
  const workspace = await fixtureWorkspace({
    '.gitignore': 'node_modules\n',
    'queue/.npmrc': `registry=http://127.0.0.1:${port}/\n`,
    'queue/package.json': JSON.stringify({
      name: '@acme/queue',
      dependencies: { 'pg-boss': '12.39.0' },
    }),
    'queue/pg-boss-citations.json': '{ "pg-boss": "12.38.2" }\n',
    'node_modules/pg-boss/package.json': JSON.stringify({
      name: 'pg-boss',
      version: '12.39.0',
    }),
    'node_modules/pg-boss/dist/manager.js': lines(NEW_MANAGER),
    ...Object.fromEntries(
      Object.entries(sources).map(([path, text]) => [`queue/${path}`, text]),
    ),
  });
  const git = (...args: string[]) => exec('git', args, { cwd: workspace.root });
  await git('init', '--quiet');
  await git('add', '--', '.');
  await git(
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--only',
    '-m',
    'base',
    '--',
    '.',
  );
  return {
    workspace,
    read: (path: string) => readFile(workspace.path(`queue/${path}`), 'utf8'),
    write: (path: string, text: string) =>
      writeFile(workspace.path(`queue/${path}`), text),
    async [Symbol.asyncDispose]() {
      await registry[Symbol.asyncDispose]();
      await workspace[Symbol.asyncDispose]();
      await old[Symbol.asyncDispose]();
    },
  };
}

async function repoint(packageDir: string, ...args: string[]) {
  try {
    const { stdout } = await exec(
      process.execPath,
      [REPOINT, packageDir, ...args],
      { encoding: 'utf8' },
    );
    return { code: 0, stdout };
  } catch (error) {
    if (!Error.isError(error) || !('code' in error) || !('stdout' in error)) {
      throw error;
    }
    return { code: error.code, stdout: String(error.stdout) };
  }
}

test('a cited line in a block that the new version rewrote is listed and not moved, and the record keeps the old version', async () => {
  // Arrange
  await using bumped = await bumpedPackage({
    'src/queue.ts':
      '// manager.js:3\n// manager.js:8\n// manager.js:9-10\n// gone.js:1\nexport {};\n',
  });

  // Act
  const { code, stdout } = await repoint(bumped.workspace.path('queue'));

  // Assert
  assert.equal(code, 1);
  assert.match(
    stdout,
    /^src\/queue\.ts:2: manager\.js:8 is in a block that pg-boss 12\.39\.0 changed\.$/m,
  );
  assert.match(
    stdout,
    /^src\/queue\.ts:3: manager\.js:9-10 is in a block that pg-boss 12\.39\.0 changed\.$/m,
  );
  assert.match(
    stdout,
    /^src\/queue\.ts:4: gone\.js:1: gone\.js is not in the dists of both 12\.38\.2 and 12\.39\.0\.$/m,
  );
  assert.equal(
    await bumped.read('src/queue.ts'),
    '// manager.js:6\n// manager.js:8\n// manager.js:9-10\n// gone.js:1\nexport {};\n',
  );
  assert.equal(
    await bumped.read('pg-boss-citations.json'),
    '{ "pg-boss": "12.38.2" }\n',
  );
});

test('after the hand check, --checked records the new version and moves nothing', async () => {
  // Arrange
  await using bumped = await bumpedPackage({
    'src/queue.ts': '// manager.js:3\nexport {};\n',
  });

  // Act
  const { code } = await repoint(bumped.workspace.path('queue'), '--checked');

  // Assert
  assert.equal(code, 0);
  assert.equal(
    await bumped.read('src/queue.ts'),
    '// manager.js:3\nexport {};\n',
  );
  assert.equal(
    await bumped.read('pg-boss-citations.json'),
    '{ "pg-boss": "12.39.0" }\n',
  );
});

test('each cited line that moved is re-pointed to its line in the new version, however the citation is written, and the record moves to the new version', async () => {
  // Arrange
  await using bumped = await bumpedPackage({
    'src/queue.ts': [
      '// manager.js:2, and manager.js:3-7',
      '/**',
      ' * as pg-boss does (manager.js:',
      ' * 11-12), and its fragments',
      ' * (4, 5-6), (manager.js:1, :9)',
      ' */',
      'const cited = "manager.js:3";',
      '// node_modules/pg/lib/client.js:4',
      'export { cited };',
      '',
    ].join('\n'),
    'src/schema.ts':
      'export const schema = `\n  id TEXT, -- manager.js:3\n  -- (manager.js:\n  -- 4-5)\n`;\nexport const note = "a -- b (3)";\n',
    'docs/adr.md': 'pg-boss starts (`manager.js:3-5`).\n',
    'node_modules/dep/README.md': 'manager.js:3\n',
  });

  // Act
  const { code, stdout } = await repoint(bumped.workspace.path('queue'));

  // Assert
  assert.equal(code, 0, stdout);
  assert.equal(
    await bumped.read('src/queue.ts'),
    [
      '// manager.js:2, and manager.js:6-10',
      '/**',
      ' * as pg-boss does (manager.js:',
      ' * 13-14), and its fragments',
      ' * (7, 8-9), (manager.js:1, :12)',
      ' */',
      'const cited = "manager.js:3";',
      '// node_modules/pg/lib/client.js:4',
      'export { cited };',
      '',
    ].join('\n'),
  );
  assert.equal(
    await bumped.read('src/schema.ts'),
    'export const schema = `\n  id TEXT, -- manager.js:6\n  -- (manager.js:\n  -- 7-8)\n`;\nexport const note = "a -- b (3)";\n',
  );
  assert.equal(
    await bumped.read('docs/adr.md'),
    'pg-boss starts (`manager.js:6-8`).\n',
  );
  assert.equal(
    await bumped.read('node_modules/dep/README.md'),
    'manager.js:3\n',
  );
  assert.equal(
    await bumped.read('pg-boss-citations.json'),
    '{ "pg-boss": "12.39.0" }\n',
  );
});

test('a line changed since HEAD, and a file git does not track, already cite the new version and are left alone', async () => {
  // Arrange
  await using bumped = await bumpedPackage({
    'src/queue.ts': '// manager.js:3\n// manager.js:4\nexport {};\n',
  });
  await bumped.write(
    'src/queue.ts',
    '// manager.js:3\n// manager.js:7, as the user wrote it\nexport {};\n',
  );
  await bumped.write('src/new.ts', '// manager.js:7\nexport {};\n');

  // Act
  const { code, stdout } = await repoint(bumped.workspace.path('queue'));

  // Assert
  assert.equal(code, 0, stdout);
  assert.equal(
    await bumped.read('src/queue.ts'),
    '// manager.js:6\n// manager.js:7, as the user wrote it\nexport {};\n',
  );
  assert.equal(
    await bumped.read('src/new.ts'),
    '// manager.js:7\nexport {};\n',
  );
  assert.match(stdout, /moved 1 in 1 files, flagged 0, skipped 2 /);
});

test('citations that already name the installed version are not touched', async () => {
  // Arrange
  await using bumped = await bumpedPackage({
    'src/queue.ts': '// manager.js:3\nexport {};\n',
  });
  await bumped.write('pg-boss-citations.json', '{ "pg-boss": "12.39.0" }\n');

  // Act
  const { code, stdout } = await repoint(bumped.workspace.path('queue'));

  // Assert
  assert.equal(code, 0);
  assert.match(stdout, /moved 0/);
  assert.equal(
    await bumped.read('src/queue.ts'),
    '// manager.js:3\nexport {};\n',
  );
});
