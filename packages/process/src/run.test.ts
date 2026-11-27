import assert from 'node:assert/strict';
import { chmod, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { Command, StartError } from './index.ts';

const node = (source: string) =>
  new Command(process.execPath, ['-e', source], { clock: globalThis, env: {} });

test('a run of a file that is not executable rejects with StartError, whose cause is EACCES', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  const file = join(folder.path, 'tool');
  await writeFile(file, '#!/bin/sh\necho ran\n');
  await chmod(file, 0o644);

  // Act
  const run = new Command(file, [], { clock: globalThis, env: {} }).run();

  // Assert
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof StartError);
    assert.equal(Reflect.get(Object(error.cause), 'code'), 'EACCES');
    return true;
  });
});

test('a name with no slash is found on the PATH of the given environment, not on the PATH of this process', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  await writeFile(join(folder.path, 'zukhruf-tool'), '#!/bin/sh\necho found\n');
  await chmod(join(folder.path, 'zukhruf-tool'), 0o755);

  // Act
  const onGivenPath = await new Command('zukhruf-tool', [], {
    clock: globalThis,
    env: { PATH: folder.path },
  }).run();
  const notOnGivenPath = new Command('node', [], {
    clock: globalThis,
    env: { PATH: '' },
  }).run();

  // Assert
  assert.equal(onGivenPath.stdout, 'found\n');
  await assert.rejects(notOnGivenPath, (error) => {
    assert.ok(error instanceof StartError);
    assert.equal(Reflect.get(Object(error.cause), 'code'), 'ENOENT');
    return true;
  });
});

test('a name with a slash is found at its path from the cwd of the command', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  await writeFile(join(folder.path, 'tool'), '#!/bin/sh\necho here\n');
  await chmod(join(folder.path, 'tool'), 0o755);

  // Act
  const run = await new Command('./tool', [], {
    clock: globalThis,
    env: {},
    cwd: folder.path,
  }).run();

  // Assert
  assert.equal(run.stdout, 'here\n');
});

test('a run that a SIGTERM ends resolves with the signal and no exit code', async () => {
  // Act
  const run = await node("process.kill(process.pid, 'SIGTERM');").run();

  // Assert
  assert.deepEqual(
    { exitCode: run.exitCode, signal: run.signal },
    { exitCode: undefined, signal: 'SIGTERM' },
  );
});

test('a run that exits with 130 ends as SIGINT, because sh cannot tell the two apart', async () => {
  // Act
  const run = await node('process.exit(130);').run();

  // Assert
  assert.deepEqual(
    { exitCode: run.exitCode, signal: run.signal },
    { exitCode: undefined, signal: 'SIGINT' },
  );
});

test('output holds stdout and stderr in the order that the process wrote them, and the text keeps its last newline', async () => {
  // Act
  const run = await node(
    "process.stdout.write('a\\n'); setTimeout(() => process.stderr.write('b\\n'), 100); setTimeout(() => process.stdout.write('c\\n'), 200);",
  ).run();

  // Assert
  assert.deepEqual(
    { stdout: run.stdout, stderr: run.stderr, output: run.output },
    { stdout: 'a\nc\n', stderr: 'b\n', output: 'a\nb\nc\n' },
  );
});

test('a run resolves with what a child of the process wrote before the streams closed', async () => {
  // Act
  const run = await new Command(
    '/bin/sh',
    ['-c', '(sleep 0.3; echo late) & echo early'],
    { clock: globalThis, env: {} },
  ).run();

  // Assert
  assert.equal(run.stdout, 'early\nlate\n');
});

test('the process gets the given environment and nothing else: no variable of this process, none of the shell, no undefined value', async () => {
  // Act
  const run = await new Command('/usr/bin/env', [], {
    clock: globalThis,
    env: { ZUKHRUF_GIVEN: 'yes', ZUKHRUF_LEFT_OUT: undefined },
  }).run();

  // Assert
  assert.equal(run.stdout, 'ZUKHRUF_GIVEN=yes\n');
});

test('a PWD and a SHLVL that the caller gives reach the process with the caller values', async () => {
  // Act
  const run = await new Command('/usr/bin/env', [], {
    clock: globalThis,
    env: { PWD: '/given/folder', SHLVL: '7' },
  }).run();

  // Assert
  assert.deepEqual(run.stdout.split('\n').filter(Boolean).toSorted(), [
    'PWD=/given/folder',
    'SHLVL=7',
  ]);
});

test('input reaches stdin, as text and as bytes, and then stdin ends', async () => {
  // Arrange
  const cat = new Command('/bin/cat', [], { clock: globalThis, env: {} });

  // Act
  const text = await cat.run({ input: 'as text\n' });
  const bytes = await cat.run({
    input: new TextEncoder().encode('as bytes\n'),
  });

  // Assert
  assert.deepEqual([text.stdout, bytes.stdout], ['as text\n', 'as bytes\n']);
});

test('without input, stdin ends at once, so a process that reads it does not wait', async () => {
  // Act
  const run = await new Command('/bin/cat', [], {
    clock: globalThis,
    env: {},
  }).run();

  // Assert
  assert.deepEqual(
    { exitCode: run.exitCode, stdout: run.stdout },
    { exitCode: 0, stdout: '' },
  );
});

test('a run with cwd runs in that folder', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');

  // Act
  const run = await node('console.log(process.cwd())').run();
  const inFolder = await new Command(
    process.execPath,
    ['-e', 'console.log(process.cwd())'],
    { clock: globalThis, env: {}, cwd: folder.path },
  ).run();

  // Assert
  assert.equal(inFolder.stdout, `${await realpath(folder.path)}\n`);
  assert.notEqual(run.stdout, inFolder.stdout);
});

test('a run that exits with 3 resolves with exit code 3 and no signal, and keeps its stdout and stderr', async () => {
  // Arrange
  const command = new Command(
    process.execPath,
    [
      '-e',
      "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3;",
    ],
    { clock: globalThis, env: {} },
  );

  // Act
  const run = await command.run();

  // Assert
  assert.deepEqual(
    {
      exitCode: run.exitCode,
      signal: run.signal,
      stdout: run.stdout,
      stderr: run.stderr,
    },
    { exitCode: 3, signal: undefined, stdout: 'out', stderr: 'err' },
  );
});

test('a StartError names the name of the command, or its file, and never its arguments', async () => {
  // Arrange
  const named = new Command('/nonexistent/zukhruf-tool', ['--token=secret'], {
    clock: globalThis,
    env: {},
    name: 'the uploader',
  });
  const unnamed = new Command('/nonexistent/zukhruf-tool', ['--token=secret'], {
    clock: globalThis,
    env: {},
  });

  // Act
  const messages = await Promise.all(
    [named, unnamed].map((command) =>
      command.run().then(
        () => assert.fail('the run resolved'),
        (error: unknown) => {
          assert.ok(error instanceof StartError);
          return error.message;
        },
      ),
    ),
  );

  // Assert
  assert.deepEqual(
    messages.map((message) => [
      message.includes('the uploader'),
      message.includes('/nonexistent/zukhruf-tool'),
      message.includes('secret'),
    ]),
    [
      [true, false, false],
      [false, true, false],
    ],
  );
});

test('a name on the PATH whose file is not executable rejects with StartError, whose cause is EACCES', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  await writeFile(join(folder.path, 'zukhruf-tool'), '#!/bin/sh\necho ran\n');
  await chmod(join(folder.path, 'zukhruf-tool'), 0o644);

  // Act
  const run = new Command('zukhruf-tool', [], {
    clock: globalThis,
    env: { PATH: folder.path },
  }).run();

  // Assert
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof StartError);
    assert.equal(Reflect.get(Object(error.cause), 'code'), 'EACCES');
    return true;
  });
});
