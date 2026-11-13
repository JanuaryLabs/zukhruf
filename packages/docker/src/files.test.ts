import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import {
  type Container,
  ContainerNotFoundError,
  Docker,
  DockerEngineError,
  NotAFileError,
  PathNotFoundError,
  ReadOnlyPathError,
} from './index.ts';
import { IMAGE, TEST_LABEL, connect, removeLabeled } from './testing/engine.ts';
import { fakeEngine } from './testing/fake-engine.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';

/** The output of a command in the container; it fails the test on a non-zero exit code. */
async function shell(container: Container, script: string): Promise<string> {
  const result = await container.exec({ Cmd: ['sh', '-c', script] });
  assert.equal(result.exitCode, 0, result.output);
  return result.stdout;
}

/** The names in a tar stream, as the tar program of this machine lists them. */
async function tarNames(
  archive: ReadableStream<Uint8Array>,
): Promise<string[]> {
  const child = spawn('tar', ['-tf', '-'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const closed = new Promise<number | null>((resolve) =>
    child.once('close', resolve),
  );
  Readable.fromWeb(archive).pipe(child.stdin);
  let names = '';
  child.stdout.setEncoding('utf8');
  for await (const chunk of child.stdout) names += String(chunk);
  assert.equal(await closed, 0);
  return names
    .split('\n')
    .filter(Boolean)
    .map((name) => name.replace(/\/$/, ''))
    .toSorted();
}

describe('the files of a container', () => {
  test('binary data with a trailing newline comes back byte for byte through writeFiles() and readFile()', async () => {
    // Arrange
    await using docker = await connect(IMAGE);
    const run = randomUUID();
    try {
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        Labels: { [TEST_LABEL]: run },
      });
      const data = new Uint8Array([
        ...Array.from({ length: 256 }, (_, byte) => byte),
        0x0a,
      ]);

      // Act
      await container.writeFiles([{ path: '/tmp/blob.bin', data }]);
      const read = await container.readFile('/tmp/blob.bin');

      // Assert
      assert.deepEqual(new Uint8Array(read), data);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('files written into a created container that never started are there after start(), with the parent directories that they imply', async () => {
    // Arrange
    await using docker = await connect(IMAGE);
    const run = randomUUID();
    try {
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        Labels: { [TEST_LABEL]: run },
      });

      // Act
      await container.writeFiles([
        { path: '/srv/app/conf/settings.txt', data: 'mode=fast\n' },
        { path: '/srv/app/cache', directory: true },
      ]);
      await container.start();

      // Assert
      assert.equal(
        new TextDecoder().decode(
          await container.readFile('/srv/app/conf/settings.txt'),
        ),
        'mode=fast\n',
      );
      assert.equal(
        await shell(
          container,
          "cat /srv/app/conf/settings.txt; stat -c '%F' /srv/app /srv/app/conf /srv/app/cache",
        ),
        'mode=fast\ndirectory\ndirectory\ndirectory\n',
      );
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('a path longer than 100 characters and one longer than 255 go in through writeFiles() and come back through readFile() and getArchive()', async () => {
    // Arrange
    await using docker = await connect(IMAGE);
    const run = randomUUID();
    try {
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        Labels: { [TEST_LABEL]: run },
      });
      await container.start();
      const long = `/tmp/deep/${'a'.repeat(60)}/${'b'.repeat(60)}.txt`;
      const longer = `/tmp/deep/${Array.from({ length: 6 }, (_, index) => String(index).repeat(50)).join('/')}/${'c'.repeat(40)}.txt`;
      assert.ok(long.length > 100 && longer.length > 255);

      // Act
      await container.writeFiles([
        { path: long, data: 'long\n' },
        { path: longer, data: 'longer\n' },
      ]);
      const names = await tarNames(await container.getArchive('/tmp/deep'));

      // Assert
      const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
      assert.equal(decode(await container.readFile(long)), 'long\n');
      assert.equal(decode(await container.readFile(longer)), 'longer\n');
      assert.equal(await shell(container, `cat '${longer}'`), 'longer\n');
      assert.ok(names.includes(long.slice('/tmp/'.length)), names.join('\n'));
      assert.ok(names.includes(longer.slice('/tmp/'.length)), names.join('\n'));
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('a written entry has its mode, and belongs to its uid and gid, or to root when it has none', async () => {
    // Arrange
    await using docker = await connect(IMAGE);
    const run = randomUUID();
    try {
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        Labels: { [TEST_LABEL]: run },
      });
      await container.start();

      // Act
      await container.writeFiles([
        {
          path: '/opt/kit/run.sh',
          data: '#!/bin/sh\n',
          mode: 0o750,
          uid: 1234,
          gid: 4321,
        },
        {
          path: '/opt/kit/private',
          directory: true,
          mode: 0o700,
          uid: 99,
          gid: 98,
        },
        { path: '/opt/kit/plain.txt', data: 'plain' },
      ]);

      // Assert
      assert.equal(
        await shell(
          container,
          "stat -c '%a %u %g' /opt/kit/run.sh /opt/kit/private /opt/kit/plain.txt",
        ),
        '750 1234 4321\n700 99 98\n644 0 0\n',
      );
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('stat() gives the path stat of a file, and undefined for a missing path and for a missing container', async () => {
    // Arrange
    await using docker = await connect(IMAGE);
    const run = randomUUID();
    try {
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        Labels: { [TEST_LABEL]: run },
      });
      await container.writeFiles([
        { path: '/srv/run.sh', data: '#!/bin/sh\n', mode: 0o755 },
      ]);

      // Act
      const stat = await container.stat('/srv/run.sh');
      const missing = await container.stat('/srv/missing.txt');
      await container.remove({ force: true });
      const gone = await container.stat('/srv/run.sh');

      // Assert
      assert.deepEqual(
        { ...stat, mtime: typeof stat?.mtime },
        {
          name: 'run.sh',
          size: 10,
          mode: 0o755,
          mtime: 'string',
          linkTarget: '',
        },
      );
      assert.equal(missing, undefined);
      assert.equal(gone, undefined);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('a stat() miss sends one request, for a missing path and for a missing container', async () => {
    // Arrange: the engine answers HEAD of the archive with 404 in both cases.
    // The inspect of c1 finds it, so its miss is a missing path; c2 is
    // removed after find(), so its miss is a missing container.
    await using scratch = await scratchDirectory();
    const inspects = new Map<string, number>();
    await using engine = await fakeEngine({
      directory: scratch.path,
      apiVersion: '1.51',
      answer: (request, response) => {
        const inspected = /^\/v1\.51\/containers\/(c[12])\/json$/.exec(
          request.url ?? '',
        )?.[1];
        const seen =
          inspected === undefined ? 0 : (inspects.get(inspected) ?? 0);
        if (inspected !== undefined) inspects.set(inspected, seen + 1);
        if (inspected === 'c1' || (inspected === 'c2' && seen === 0)) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ Id: inspected }));
          return;
        }
        response.writeHead(404);
        response.end();
      },
    });
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const present = await docker.containers.find('c1');
    const removed = await docker.containers.find('c2');
    assert.ok(present && removed);
    const found = engine.paths.length;

    // Act
    const missingPath = await present.stat('/srv/missing.txt');
    const missingContainer = await removed.stat('/srv/run.sh');

    // Assert
    assert.equal(missingPath, undefined);
    assert.equal(missingContainer, undefined);
    assert.deepEqual(engine.paths.slice(found), [
      '/v1.51/containers/c1/archive?path=%2Fsrv%2Fmissing.txt',
      '/v1.51/containers/c2/archive?path=%2Fsrv%2Frun.sh',
    ]);
  });

  test('stat() of a 500 rejects with a DockerEngineError of that status', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await fakeEngine({
      directory: scratch.path,
      apiVersion: '1.51',
      answer: (request, response) => {
        if (request.url === '/v1.51/containers/c1/json') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ Id: 'c1' }));
          return;
        }
        response.writeHead(500);
        response.end();
      },
    });
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const container = await docker.containers.find('c1');
    assert.ok(container);

    // Act
    const statting = container.stat('/srv/run.sh');

    // Assert
    await assert.rejects(statting, (error: unknown) => {
      assert.ok(error instanceof DockerEngineError, String(error));
      assert.ok(!(error instanceof ContainerNotFoundError));
      assert.equal(error.status, 500);
      assert.deepEqual(error.request, {
        method: 'HEAD',
        path: '/containers/c1/archive',
      });
      return true;
    });
  });

  test('readFile() of a missing path is a PathNotFoundError, of a directory or a symlink a NotAFileError of that kind, and of a missing container a ContainerNotFoundError', async () => {
    // Arrange
    await using docker = await connect(IMAGE);
    const run = randomUUID();
    try {
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        Labels: { [TEST_LABEL]: run },
      });

      // Act
      const missing = container.readFile('/etc/missing.conf');
      const directory = container.readFile('/etc');
      const symlink = container.readFile('/bin/sh');
      await Promise.allSettled([missing, directory, symlink]);
      await container.remove({ force: true });
      const gone = container.readFile('/etc/hostname');
      await Promise.allSettled([gone]);

      // Assert
      await assert.rejects(missing, (error) => {
        assert.ok(error instanceof PathNotFoundError);
        assert.equal(error.container, container.id);
        assert.equal(error.path, '/etc/missing.conf');
        assert.deepEqual(error.request, {
          method: 'GET',
          path: `/containers/${container.id}/archive`,
        });
        return true;
      });
      await assert.rejects(directory, (error) => {
        assert.ok(error instanceof NotAFileError);
        assert.equal(error.kind, 'directory');
        assert.equal(error.path, '/etc');
        assert.equal(error.request.path, `/containers/${container.id}/archive`);
        return true;
      });
      await assert.rejects(symlink, (error) => {
        assert.ok(error instanceof NotAFileError);
        assert.equal(error.kind, 'symlink');
        return true;
      });
      await assert.rejects(gone, ContainerNotFoundError);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('with a read-only root filesystem, writeFiles() into a writable volume at /data works, and into /etc is a ReadOnlyPathError', async () => {
    // Arrange
    await using docker = await connect(IMAGE);
    const run = randomUUID();
    await using data = await docker.volumes.create({
      Labels: { [TEST_LABEL]: run },
    });
    try {
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        Labels: { [TEST_LABEL]: run },
        HostConfig: {
          ReadonlyRootfs: true,
          Mounts: [{ Type: 'volume', Source: data.name, Target: '/data' }],
        },
      });

      // Act
      await container.writeFiles([
        { path: '/data/notes/today.txt', data: 'kept\n' },
      ]);
      const refused = container.writeFiles([
        { path: '/etc/app.conf', data: 'x' },
      ]);

      // Assert
      assert.equal(
        new TextDecoder().decode(
          await container.readFile('/data/notes/today.txt'),
        ),
        'kept\n',
      );
      await assert.rejects(refused, (error) => {
        assert.ok(error instanceof ReadOnlyPathError);
        assert.equal(error.container, container.id);
        assert.equal(error.path, '/etc');
        assert.deepEqual(error.request, {
          method: 'PUT',
          path: `/containers/${container.id}/archive`,
        });
        return true;
      });
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('writeFiles() into a read-only mount of a container with a writable root filesystem is a ReadOnlyPathError', async () => {
    // Arrange
    await using docker = await connect(IMAGE);
    const run = randomUUID();
    try {
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        Labels: { [TEST_LABEL]: run },
        HostConfig: {
          Mounts: [
            // An image mount is read-only. An engine at API 1.51 refuses a read-only anonymous volume.
            { Type: 'image', Source: IMAGE, Target: '/ro' },
          ],
        },
      });

      // Act
      const refused = container.writeFiles([
        { path: '/ro/app.conf', data: 'x' },
      ]);

      // Assert
      await assert.rejects(refused, (error) => {
        assert.ok(error instanceof ReadOnlyPathError);
        assert.equal(error.path, '/ro');
        return true;
      });
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('putArchive() with copyUIDGID gives the entry to the user of the container; without it, and in writeFiles(), the owner in the archive stays', async () => {
    // Arrange
    await using docker = await connect(IMAGE);
    const run = randomUUID();
    try {
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        User: '1000:1000',
        Labels: { [TEST_LABEL]: run },
      });
      await container.start();
      await container.writeFiles([
        { path: '/tmp/source/owned.txt', data: 'owned\n' },
      ]);

      await container.writeFiles([
        { path: '/tmp/kept/x', directory: true },
        { path: '/tmp/copied/x', directory: true },
      ]);

      // Act
      await container.putArchive(
        '/tmp/kept',
        await container.getArchive('/tmp/source/owned.txt'),
      );
      await container.putArchive(
        '/tmp/copied',
        await container.getArchive('/tmp/source/owned.txt'),
        { copyUIDGID: true },
      );

      // Assert
      assert.equal(
        await shell(
          container,
          "stat -c '%u %g' /tmp/source/owned.txt /tmp/kept/owned.txt /tmp/copied/owned.txt",
        ),
        '0 0\n0 0\n1000 1000\n',
      );
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('writeFiles() of a file onto a directory rejects, and the tree of the directory stays', async () => {
    // Arrange
    await using docker = await connect(IMAGE);
    const run = randomUUID();
    try {
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        Labels: { [TEST_LABEL]: run },
      });
      await container.writeFiles([
        { path: '/workspace/dir/keep.txt', data: 'keep\n' },
      ]);

      // Act
      const refused = container.writeFiles([
        { path: '/workspace/dir', data: 'not a directory\n' },
      ]);

      // Assert
      await assert.rejects(refused, (error) => {
        assert.ok(error instanceof DockerEngineError);
        assert.match(error.message, /^cannot overwrite directory /);
        return true;
      });
      assert.equal(
        new TextDecoder().decode(
          await container.readFile('/workspace/dir/keep.txt'),
        ),
        'keep\n',
      );
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('writeFiles() of a directory onto a file rejects, and the file stays', async () => {
    // Arrange
    await using docker = await connect(IMAGE);
    const run = randomUUID();
    try {
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        Labels: { [TEST_LABEL]: run },
      });
      await container.writeFiles([
        { path: '/workspace/file.txt', data: 'keep\n' },
      ]);

      // Act
      const refused = container.writeFiles([
        { path: '/workspace/file.txt', directory: true },
      ]);

      // Assert
      await assert.rejects(refused, (error) => {
        assert.ok(error instanceof DockerEngineError);
        assert.match(error.message, /^cannot overwrite non-directory /);
        return true;
      });
      assert.equal(
        new TextDecoder().decode(
          await container.readFile('/workspace/file.txt'),
        ),
        'keep\n',
      );
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('getArchive() of a directory is a tar stream of its entries', async () => {
    // Arrange
    await using docker = await connect(IMAGE);
    const run = randomUUID();
    try {
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        Labels: { [TEST_LABEL]: run },
      });
      await container.writeFiles([
        { path: '/srv/tree/a.txt', data: 'a' },
        { path: '/srv/tree/sub/b.txt', data: 'b' },
        { path: '/srv/tree/empty', directory: true },
      ]);

      // Act
      const names = await tarNames(await container.getArchive('/srv/tree'));

      // Assert
      assert.deepEqual(names, [
        'tree',
        'tree/a.txt',
        'tree/empty',
        'tree/sub',
        'tree/sub/b.txt',
      ]);
    } finally {
      await removeLabeled(docker, run);
    }
  });
});
