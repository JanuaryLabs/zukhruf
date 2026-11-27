import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type Socket, connect, createServer } from 'node:net';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';

import { poll } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';

import { Command, EndedBeforeReadyError, type PipedProcess } from './index.ts';

const node = (source: string) =>
  new Command(process.execPath, ['-e', source], { clock: globalThis, env: {} });

const cat = new Command('/bin/cat', [], { clock: globalThis, env: {} });

/**
 * The two ends of a unix socket: the process gets `theirs`, as `sshd -i` gets
 * its connection, and the test talks through `ours`.
 */
async function socketPair(path: string) {
  const accepted = Promise.withResolvers<Socket>();
  const server = createServer({ pauseOnConnect: true }, (socket) => {
    accepted.resolve(socket);
  });
  server.listen(path);
  await once(server, 'listening');
  const ours = connect(path);
  await once(ours, 'connect');
  const theirs = await accepted.promise;
  return {
    ours,
    theirs,
    [Symbol.asyncDispose]: async () => {
      ours.destroy();
      theirs.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

test('a reader that breaks out of lines() returns at once while the process runs', async () => {
  // Arrange
  await using started = await node(
    "console.log('first'); setInterval(() => {}, 1000);",
  ).start();

  // Act
  let first: string | undefined;
  for await (const line of started.lines()) {
    first = line;
    break;
  }

  // Assert
  assert.equal(first, 'first');
});

test('after a reader breaks, a later reader gets the lines from the first one, and the lines that came after', async () => {
  // Arrange
  await using started = await node(
    "console.log('one'); process.stdin.once('data', () => console.log('two'));",
  ).start();
  for await (const line of started.lines()) if (line === 'one') break;

  // Act
  started.stdin.end('go\n');
  const lines = await Array.fromAsync(started.lines());

  // Assert
  assert.deepEqual(lines, ['one', 'two']);
});

test('two readers that iterate lines() at the same time each get every line, in order', async () => {
  // Arrange
  await using started = await node(
    "for (const line of ['one', 'two', 'three']) console.log(line);",
  ).start();

  // Act
  const both = await Promise.all([
    Array.fromAsync(started.lines()),
    Array.fromAsync(started.lines()),
  ]);

  // Assert
  assert.deepEqual(both, [
    ['one', 'two', 'three'],
    ['one', 'two', 'three'],
  ]);
});

test('after the ready line, lines() gives the lines before it, the ready line and the lines after it', async () => {
  // Act
  await using started = await node(
    "for (const line of ['starting', 'ready', 'after']) console.log(line);",
  ).start({ ready: { line: 'ready' } });

  // Assert
  assert.deepEqual(await Array.fromAsync(started.lines()), [
    'starting',
    'ready',
    'after',
  ]);
});

test('a first reader that starts after the process has ended gets every line, and then its iteration ends', async () => {
  // Arrange
  await using started = await node(
    "for (const line of ['one', 'two']) console.log(line);",
  ).start();
  await started.ended;

  // Act
  const lines = await Array.fromAsync(started.lines());

  // Assert
  assert.deepEqual(lines, ['one', 'two']);
});

test('lines end at \\n and at \\r\\n, also when the \\n comes more than 100 ms after the \\r; a line longer than a pipe holds stays one line, and a last line with no newline is a line', async () => {
  // Arrange
  const long = 'x'.repeat(100_000);
  // readline reads a \n that comes more than crlfDelay after its \r as a
  // second line end, and it raises any crlfDelay below 100 ms to 100 ms.
  await using started = await node(
    `process.stdout.write('one\\r');
     process.stdin.once('data', () => setTimeout(() => process.stdout.write('\\ntwo\\n' + 'x'.repeat(100000) + '\\nlast'), 150));`,
  ).start();
  for await (const line of started.lines()) if (line === 'one') break;

  // Act
  started.stdin.end('go\n');
  const lines = await Array.fromAsync(started.lines());

  // Assert
  assert.deepEqual(lines, ['one', 'two', long, 'last']);
});

test('with piped stdout and no reader, a large write of the process does not drain; a reader then gets every line, and the write drains', async (t) => {
  // Arrange
  // The timer of the process is the reference: a package that read stdout
  // without a reader would drain the 4 MB long before 300 ms.
  await using started = await node(
    `const fs = require('node:fs');
     process.stdout.write(('x'.repeat(99) + '\\n').repeat(40000), () => fs.writeSync(2, 'drained\\n'));
     setTimeout(() => fs.writeSync(2, 'waited\\n'), 300);`,
  ).start();
  await poll(
    async () => (started.stderrTail().includes('waited') ? true : undefined),
    { interval: 20, clock: globalThis, signal: t.signal },
  );
  const unread = started.stderrTail();

  // Act
  const lines = await Array.fromAsync(started.lines());

  // Assert
  await started.ended;
  assert.deepEqual(
    [unread, lines.length, started.stderrTail()],
    ['waited\n', 40_000, 'waited\ndrained\n'],
  );
});

test("with stdout 'ignore', a process that writes 2 MB of lines ends with no reader, and lines() is empty", async () => {
  // Act
  await using started = await node(
    "process.stdout.write(('x'.repeat(99) + '\\n').repeat(20000));",
  ).start({ stdout: 'ignore' });

  // Assert
  assert.deepEqual(
    [await started.ended, await Array.fromAsync(started.lines())],
    [{ exitCode: 0 }, []],
  );
});

void test.each(
  [
    [100, 'all of them'],
    [16_384, 'all of them'],
    [16_385, 'all but the first'],
    [102_400, 'the last 16 384'],
  ] as const,
  ([size, kept]) =>
    test(`a process that writes ${size} characters to stderr ends with no reader, and stderrTail() gives ${kept}`, async () => {
      // Arrange
      const written = Array.from({ length: size }, (_, i) =>
        String(i % 10),
      ).join('');

      // Act
      await using started = await node(
        `process.stderr.write(Array.from({ length: ${size} }, (_, i) => String(i % 10)).join(''));`,
      ).start();

      // Assert
      assert.deepEqual(
        [await started.ended, started.stderrTail()],
        [{ exitCode: 0 }, written.slice(-16_384)],
      );
    }),
);

test('with stdin and stdout one socket, the process talks to the other end as its own, its stdin is null and lines() is empty', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  await using pair = await socketPair(join(folder.path, 's'));
  await using started = await cat.start({
    stdin: pair.theirs,
    stdout: pair.theirs,
    stderr: 'ignore',
  });
  pair.theirs.destroy();

  // Act
  pair.ours.end('hello\n');
  const echoed = await text(pair.ours);

  // Assert
  assert.deepEqual(
    [
      echoed,
      started.stdin,
      await Array.fromAsync(started.lines()),
      await started.ended,
    ],
    ['hello\n', null, [], { exitCode: 0 }],
  );
});

test('with stdin a socket and stdout piped, the line that the other end sends makes the start ready, and stdin is null', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  await using pair = await socketPair(join(folder.path, 's'));

  // Act
  const starting = cat.start({ stdin: pair.theirs, ready: { line: 'ready' } });
  pair.ours.write('ready\n');
  await using started = await starting;
  pair.theirs.destroy();
  pair.ours.end();

  // Assert
  assert.deepEqual(
    [
      started.stdin,
      await Array.fromAsync(started.lines()),
      await started.ended,
    ],
    [null, ['ready'], { exitCode: 0 }],
  );
});

test('with stdin piped and stdout a socket, what the caller writes to stdin reaches the other end', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  await using pair = await socketPair(join(folder.path, 's'));
  await using started = await cat.start({
    stdout: pair.theirs,
    stderr: 'ignore',
  });
  pair.theirs.destroy();
  assert.ok(started.stdin);

  // Act
  started.stdin.end('hello\n');

  // Assert
  assert.equal(await text(pair.ours), 'hello\n');
});

test("with stdin 'ignore', stdin is null and a process that reads stdin sees its end at once", async () => {
  // Act
  await using started = await cat.start({ stdin: 'ignore' });

  // Assert
  assert.equal(started.stdin, null);
  assert.deepEqual(
    [await started.ended, await Array.fromAsync(started.lines())],
    [{ exitCode: 0 }, []],
  );
});

test("with stderr 'ignore', stderrTail() is empty also when the process writes to stderr", async () => {
  // Arrange
  await using started = await node("process.stderr.write('dropped');").start({
    stderr: 'ignore',
  });

  // Act
  await started.ended;

  // Assert
  assert.equal(started.stderrTail(), '');
});

test('a start with stdin and stdout piped gives a PipedProcess, by default and when the options name the pipes, and what the caller writes to its stdin reaches the process', async () => {
  // Arrange
  await using byDefault: PipedProcess = await cat.start();
  await using named: PipedProcess = await cat.start({
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });

  // Act
  byDefault.stdin.end('first\n');
  named.stdin.end('second\n');

  // Assert
  assert.deepEqual(
    [
      await Array.fromAsync(byDefault.lines()),
      await Array.fromAsync(named.lines()),
    ],
    [['first'], ['second']],
  );
});

test('a start with stdin ignored or a socket gives no PipedProcess, and a ready line needs piped stdout', async () => {
  // Arrange
  // Only the type checker refuses these starts, so they start a file that ends at once.
  const ends = new Command('/usr/bin/true', [], { clock: globalThis, env: {} });
  await using folder = await new TemporaryFiles().directory('process-');
  await using pair = await socketPair(join(folder.path, 's'));

  // Act
  // @ts-expect-error with stdin 'ignore', stdin can be null
  await using ignored: PipedProcess = await ends.start({ stdin: 'ignore' });
  // @ts-expect-error with stdin a socket, stdin can be null
  await using socketed: PipedProcess = await ends.start({ stdin: pair.theirs });
  // @ts-expect-error a ready line needs piped stdout, not 'ignore'
  const notPiped = ends.start({ stdout: 'ignore', ready: { line: 'never' } });
  // @ts-expect-error a ready line needs piped stdout, not a socket
  const toSocket = ends.start({
    stdout: pair.theirs,
    ready: { line: 'never' },
  });

  // Assert
  await Promise.all([
    assert.rejects(notPiped, EndedBeforeReadyError),
    assert.rejects(toSocket, EndedBeforeReadyError),
  ]);
  assert.deepEqual([ignored.stdin, socketed.stdin], [null, null]);
});
