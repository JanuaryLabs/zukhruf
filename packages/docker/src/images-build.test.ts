import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { packTar } from 'modern-tar';

import type { WallClock } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';

import {
  BuildFailedError,
  Docker,
  DockerEngineError,
  NotAFileError,
  PathNotFoundError,
} from './index.ts';
import { TEST_LABEL, removeLabeled } from './testing/engine.ts';

/** A small base at a pinned tag. Each build names linux/amd64, so the base is pulled for it, as ADR 0016 says the caller does. */
const BASE = 'alpine:3.20.3';
const PLATFORM = 'linux/amd64';

/**
 * Pulls each time: on the containerd image store, an inspect with a platform
 * answers for each platform of the index, also one whose content is not on
 * the engine, so it is no presence check.
 */
async function connect(clock: WallClock = globalThis): Promise<Docker> {
  const docker = await Docker.connect({ clock, environment: process.env });
  await docker.images.pull(BASE, { platform: PLATFORM });
  return docker;
}

/** The label of each container and image of the run: the cleanup finds them by it. */
function own(run: string): Record<string, string> {
  return { [TEST_LABEL]: run };
}

/**
 * Removes the containers of the run, each image with the label of the run,
 * also one that got no name, and each other name, then fails when an image of
 * the run is left.
 */
async function removeOwn(
  docker: Docker,
  run: string,
  ...names: string[]
): Promise<void> {
  await removeLabeled(docker, run);
  const filters = { label: [`${TEST_LABEL}=${run}`] };
  for (const { Id } of await docker.images.list({ all: true, filters })) {
    await docker.images.remove(Id, { force: true });
  }
  for (const name of names) await docker.images.remove(name);
  assert.deepEqual(await docker.images.list({ all: true, filters }), []);
}

/**
 * A started container that sees each process of the engine host through the
 * /proc of the host. The command line of a step of the build holds the run.
 */
async function startProcessWatcher(docker: Docker, run: string) {
  const watcher = await docker.containers.create({
    Image: BASE,
    Cmd: ['sleep', '600'],
    // In the environment, not in a command line, so that no process of the watcher matches.
    Env: [`STEP=${run}`],
    HostConfig: { Binds: ['/proc:/host/proc:ro'] },
    Labels: own(run),
  });
  await watcher.start();
  return {
    /** Whether, within `seconds`, a process whose command line holds the run comes (`true`) or is gone (`false`). */
    async waitFor(present: boolean, seconds: number): Promise<boolean> {
      const script = [
        'echo "$STEP" > /tmp/step',
        `end=$(($(date +%s) + ${seconds}))`,
        'while [ "$(date +%s)" -lt "$end" ]; do',
        `  if grep -qsFf /tmp/step /host/proc/[0-9]*/cmdline; then [ ${present ? 1 : 0} = 1 ] && exit 0; else [ ${present ? 1 : 0} = 0 ] && exit 0; fi`,
        '  sleep 0.1',
        'done',
        'exit 1',
      ].join('\n');
      const { exitCode } = await watcher.exec({ Cmd: ['sh', '-c', script] });
      return exitCode === 0;
    },
  };
}

/** The text of a file in a container of the image; the container is never started. */
async function readText(
  docker: Docker,
  image: string,
  run: string,
  ...paths: string[]
): Promise<string[]> {
  const container = await docker.containers.create({
    Image: image,
    Labels: own(run),
  });
  const decoder = new TextDecoder();
  return Promise.all(
    paths.map(async (path) => decoder.decode(await container.readFile(path))),
  );
}

describe('docker.images.build()', () => {
  test('a RUN that fails rejects with BuildFailedError, with the name of its step and the last 64 KiB of its output, and tags no image', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const name = `zukhruf-test-${run}:failed`;
    const command = `head -c 70000 /dev/zero | tr '\\0' x; echo; echo end-${run}; exit 3`;
    try {
      // Act
      const building = docker.images.build(
        {
          files: [
            { path: 'Dockerfile', data: `FROM ${BASE}\nRUN ${command}\n` },
          ],
        },
        { t: name, platform: PLATFORM, labels: own(run) },
      );

      // Assert
      await assert.rejects(building, (error) => {
        assert.ok(error instanceof BuildFailedError);
        assert.ok(error instanceof DockerEngineError);
        assert.equal(error.status, undefined);
        assert.deepEqual(error.request, { method: 'POST', path: '/build' });
        assert.equal(error.vertex, `[2/2] RUN ${command}`);
        assert.ok(
          error.output.endsWith(`end-${run}\n`),
          error.output.slice(-200),
        );
        assert.ok(Buffer.byteLength(error.output) <= 64 * 1024);
        assert.ok(Buffer.byteLength(error.output) > 60 * 1024);
        assert.match(error.output, /^x+\n/);
        return true;
      });
      assert.equal(await docker.images.inspect(name), undefined);
    } finally {
      await removeOwn(docker, run);
    }
  });

  test('a base image that is not on the engine rejects with BuildFailedError, whose step or output names the image', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const missing = `zukhruf-missing-${run}:1`;
    try {
      // Act
      const building = docker.images.build(
        {
          files: [{ path: 'Dockerfile', data: `FROM ${missing}\nRUN true\n` }],
        },
        { platform: PLATFORM, labels: own(run) },
      );

      // Assert
      await assert.rejects(building, (error) => {
        assert.ok(error instanceof BuildFailedError);
        assert.equal(error.status, undefined);
        // The step that resolves the base, by its name; never the message, whose text differs by engine.
        assert.ok(
          `${error.vertex}\n${error.output}`.includes(`zukhruf-missing-${run}`),
          `${error.vertex}\n${error.output}`,
        );
        return true;
      });
    } finally {
      await removeOwn(docker, run);
    }
  });

  test('a base image that only the engine has builds: the build uses the image that the caller pulled, and does not ask the registry to pull it', async () => {
    // Arrange: a name of the base that no registry has.
    await using docker = await connect();
    const run = randomUUID();
    const base = `zukhruf-test-${run}-base:1`;
    const name = `zukhruf-test-${run}:local`;
    await docker.images.tag(BASE, base);
    try {
      // Act
      const { ID } = await docker.images.build(
        { files: [{ path: 'Dockerfile', data: `FROM ${base}\nRUN true\n` }] },
        { t: name, platform: PLATFORM, labels: own(run) },
      );

      // Assert
      assert.equal((await docker.images.inspect(name))?.Id, ID);
    } finally {
      await removeOwn(docker, run, base);
    }
  });

  test('an abort of the signal rejects with its reason and stops the running step on the engine, so no image gets the name', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const name = `zukhruf-test-${run}:aborted`;
    const controller = new AbortController();
    const reason = new Error('stop the build');
    try {
      const watcher = await startProcessWatcher(docker, run);
      // The shell waits for the echo after the sleep, so its command line, with the run, stays.
      const building = docker.images.build(
        {
          files: [
            {
              path: 'Dockerfile',
              data: `FROM ${BASE}\nRUN sleep 300; echo ${run}\n`,
            },
          ],
        },
        {
          t: name,
          platform: PLATFORM,
          labels: own(run),
          signal: controller.signal,
        },
      );
      const settled = Promise.allSettled([building]);
      const started = await watcher.waitFor(true, 120);

      // Act
      controller.abort(reason);

      // Assert: a step that goes on runs for 300 s, past the bound of 60 s.
      const stopped = await watcher.waitFor(false, 60);
      assert.equal(started, true);
      assert.equal(stopped, true);
      assert.deepEqual(await settled, [{ status: 'rejected', reason }]);
      assert.equal(await docker.images.inspect(name), undefined);
    } finally {
      controller.abort(reason);
      await removeOwn(docker, run);
    }
  });

  test('files in memory build: each file and directory is in the image with its mode, a string as UTF-8, and the mtime of the clock', async () => {
    // Arrange
    const now = Date.UTC(2003, 4, 6, 7, 8, 9);
    await using docker = await connect({
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      performance: globalThis.performance,
      Date: { now: () => now },
    });
    const run = randomUUID();
    const name = `zukhruf-test-${run}:files`;
    // The run in the text: the cache key of COPY reads no mtime, so a context that an earlier run sent would give its old mtime.
    const text = `héllo wörld ✓ مرحبا 🐳 ${run}\n`;
    try {
      // Act
      const { ID } = await docker.images.build(
        {
          files: [
            { path: 'Dockerfile', data: `FROM ${BASE}\nCOPY . /ctx/\n` },
            { path: 'bin', directory: true, mode: 0o750 },
            { path: 'bin/run.sh', data: '#!/bin/sh\necho run\n', mode: 0o755 },
            { path: 'data.bin', data: new Uint8Array([0, 1, 2, 255]) },
            { path: 'text.txt', data: text },
          ],
        },
        { t: name, platform: PLATFORM, labels: own(run) },
      );

      // Assert
      assert.equal((await docker.images.inspect(name))?.Id, ID);
      const container = await docker.containers.create({
        Image: name,
        Labels: own(run),
      });
      assert.deepEqual(
        new Uint8Array(await container.readFile('/ctx/text.txt')),
        new TextEncoder().encode(text),
      );
      for (const path of ['/ctx/text.txt', '/ctx/data.bin', '/ctx/bin']) {
        assert.equal(
          (await container.stat(path))?.mtime,
          '2003-05-06T07:08:09Z',
          path,
        );
      }
      assert.equal(
        new TextDecoder().decode(await container.readFile('/ctx/bin/run.sh')),
        '#!/bin/sh\necho run\n',
      );
      assert.deepEqual(
        new Uint8Array(await container.readFile('/ctx/data.bin')),
        new Uint8Array([0, 1, 2, 255]),
      );
      assert.equal(
        ((await container.stat('/ctx/bin/run.sh'))?.mode ?? 0) & 0o777,
        0o755,
      );
      assert.equal(
        ((await container.stat('/ctx/bin'))?.mode ?? 0) & 0o777,
        0o750,
      );
    } finally {
      await removeOwn(docker, run);
    }
  });

  test('a context whose first entry has a name of more than 100 bytes builds, from files and from a folder', async () => {
    // Arrange: such a name needs a PAX header, whose records fill the first
    // 1024 bytes of a plain tar that BuildKit reads to tell a tar from a Dockerfile.
    await using docker = await connect();
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    const run = randomUUID();
    const fromFiles = `zukhruf-test-${run}:files`;
    const fromFolder = `zukhruf-test-${run}:folder`;
    // '0' comes before 'Dockerfile' in the byte order of the walk of a folder.
    const long = `0${'n'.repeat(119)}`;
    const dockerfile = `FROM ${BASE}\nCOPY . /ctx/\n`;
    await writeFile(join(scratch.path, long), 'long\n');
    await writeFile(join(scratch.path, 'Dockerfile'), dockerfile);
    try {
      // Act
      await docker.images.build(
        {
          files: [
            { path: long, data: 'long\n' },
            { path: 'Dockerfile', data: dockerfile },
          ],
        },
        { t: fromFiles, platform: PLATFORM, labels: own(run) },
      );
      await docker.images.build(
        { directory: scratch.path },
        { t: fromFolder, platform: PLATFORM, labels: own(run) },
      );

      // Assert
      for (const name of [fromFiles, fromFolder]) {
        assert.deepEqual(await readText(docker, name, run, `/ctx/${long}`), [
          'long\n',
        ]);
      }
    } finally {
      await removeOwn(docker, run);
    }
  });

  test('a folder builds as its .dockerignore filters it, with an exception inside an excluded folder, the Dockerfile and .dockerignore always sent, and each mode, mtime, link and owner 0:0', async () => {
    // Arrange
    await using docker = await connect();
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    const folder = scratch.path;
    const run = randomUUID();
    const name = `zukhruf-test-${run}:folder`;
    await writeFile(
      join(folder, 'Dockerfile'),
      [
        `FROM ${BASE}`,
        // The bind mount shows the context as the engine got it, owner and all; COPY gives each file to root.
        `RUN --mount=type=bind,target=/ctx stat -c '%u:%g' /ctx/run.sh > /owner.txt`,
        'COPY . /ctx/',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(folder, '.dockerignore'),
      'Dockerfile\n.dockerignore\n*.log\ndocs\n!docs/keep.md\n',
    );
    // The run in the script: the cache key of COPY reads no mtime, so an earlier run would give its old mtime.
    await writeFile(join(folder, 'run.sh'), `#!/bin/sh\n# ${run}\n`);
    await chmod(join(folder, 'run.sh'), 0o755);
    const mtime = new Date('2001-02-03T04:05:06Z');
    await utimes(join(folder, 'run.sh'), mtime, mtime);
    await symlink('run.sh', join(folder, 'link'));
    await writeFile(join(folder, 'app.log'), 'log\n');
    await mkdir(join(folder, 'docs'));
    await writeFile(join(folder, 'docs', 'keep.md'), 'keep\n');
    await writeFile(join(folder, 'docs', 'other.md'), 'other\n');
    try {
      // Act
      await docker.images.build(
        { directory: folder },
        { t: name, platform: PLATFORM, labels: own(run) },
      );

      // Assert
      const container = await docker.containers.create({
        Image: name,
        Labels: own(run),
      });
      const text = async (path: string) =>
        new TextDecoder().decode(await container.readFile(path));
      assert.equal(await text('/ctx/docs/keep.md'), 'keep\n');
      assert.match(await text('/ctx/Dockerfile'), /^FROM /);
      assert.match(await text('/ctx/.dockerignore'), /^Dockerfile\n/);
      for (const excluded of ['/ctx/docs/other.md', '/ctx/app.log']) {
        await assert.rejects(container.readFile(excluded), PathNotFoundError);
      }
      await assert.rejects(container.readFile('/ctx/link'), (error) => {
        assert.ok(error instanceof NotAFileError);
        assert.equal(error.kind, 'symlink');
        return true;
      });
      const script = await container.stat('/ctx/run.sh');
      assert.equal((script?.mode ?? 0) & 0o777, 0o755);
      assert.equal(script?.mtime, '2001-02-03T04:05:06Z');
      assert.equal(await text('/owner.txt'), '0:0\n');
    } finally {
      await removeOwn(docker, run);
    }
  });

  test('a tar archive of the caller goes as it is: an uncompressed one builds, and one whose first entry needs a PAX header fails, as the README says', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const name = `zukhruf-test-${run}:archive`;
    const pax = `zukhruf-test-${run}:pax`;
    const file = (path: string, text: string) => {
      const body = new TextEncoder().encode(text);
      return {
        header: {
          name: path,
          type: 'file' as const,
          size: body.byteLength,
          mode: 0o644,
          uid: 0,
          gid: 0,
          mtime: new Date(0),
        },
        body,
      };
    };
    const archive = await packTar([
      file('Dockerfile', `FROM ${BASE}\nCOPY hello.txt /hello.txt\n`),
      file('hello.txt', `hello ${run}\n`),
    ]);
    // Gzipped or repacked with a short first entry, this one would build.
    const paxFirst = await packTar([
      file('n'.repeat(120), 'long\n'),
      file('Dockerfile', `FROM ${BASE}\n`),
    ]);
    try {
      // Act
      await docker.images.build(
        { archive: new Blob([archive]).stream() },
        { t: name, platform: PLATFORM, labels: own(run) },
      );
      const building = docker.images.build(
        { archive: paxFirst },
        { t: pax, platform: PLATFORM, labels: own(run) },
      );

      // Assert
      await assert.rejects(building, BuildFailedError);
      assert.deepEqual(await readText(docker, name, run, '/hello.txt'), [
        `hello ${run}\n`,
      ]);
      assert.equal(await docker.images.inspect(pax), undefined);
    } finally {
      await removeOwn(docker, run);
    }
  });

  test('t, buildargs, labels, target, dockerfile and platform reach the image, and the result is its ID', async () => {
    // Arrange: a platform that is not the one of the engine, so that a build that drops it gives another one.
    await using docker = await connect();
    const run = randomUUID();
    const names = [`zukhruf-test-${run}:a`, `zukhruf-test-${run}:b`];
    const architecture =
      (await docker.info()).Architecture === 'x86_64' ? 'arm64' : 'amd64';
    await docker.images.pull(BASE, { platform: `linux/${architecture}` });
    try {
      // Act: no RUN, so no emulator of the other platform is needed.
      const { ID } = await docker.images.build(
        {
          files: [
            {
              path: 'build/app.Dockerfile',
              data: [
                `FROM ${BASE} AS first`,
                'ARG GREETING',
                'LABEL stage=first greeting=$GREETING',
                `FROM ${BASE} AS second`,
                'LABEL stage=second',
                '',
              ].join('\n'),
            },
          ],
        },
        {
          dockerfile: 'build/app.Dockerfile',
          t: names,
          buildargs: { GREETING: `hello ${run}` },
          labels: { ...own(run), 'dev.zukhruf.test.build': run },
          target: 'first',
          platform: `linux/${architecture}`,
        },
      );

      // Assert
      const [a, b] = await Promise.all(
        names.map((each) => docker.images.inspect(each)),
      );
      assert.match(ID, /^sha256:[0-9a-f]{64}$/);
      assert.equal(a?.Id, ID);
      assert.equal(b?.Id, ID);
      assert.equal(a?.Architecture, architecture);
      assert.equal(a?.Config?.Labels?.stage, 'first');
      assert.equal(a?.Config?.Labels?.greeting, `hello ${run}`);
      assert.equal(a?.Config?.Labels?.['dev.zukhruf.test.build'], run);
    } finally {
      await removeOwn(docker, run);
    }
  });
});
