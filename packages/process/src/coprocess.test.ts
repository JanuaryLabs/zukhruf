import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import { Command, Coprocess, ProcessEndedError } from './index.ts';
import { groupExists, groupOf } from './testing/processes.ts';

/**
 * A Node.js process that answers each JSON line with the value it got, or with
 * three lines for {"many":true}, and obeys a few commands.
 */
const ECHO = `
const lines = require('node:readline').createInterface({ input: process.stdin });
let exiting = false;
lines.on('line', (line) => {
  if (exiting) return;
  const value = JSON.parse(line);
  if (value.exit !== undefined) {
    exiting = true;
    process.stderr.write(value.stderr ?? '');
    return process.stdout.write(
      value.last === undefined ? '' : JSON.stringify(value.last) + '\\n',
      () => process.exit(value.exit),
    );
  }
  if (value.garbage) return process.stdout.write('not json\\n');
  if (value.hang) return process.stdout.write(JSON.stringify({ hanging: true }) + '\\n');
  if (value.many) {
    for (const step of [1, 2, 3]) process.stdout.write(JSON.stringify({ step }) + '\\n');
    return;
  }
  process.stdout.write(JSON.stringify({ echo: value }) + '\\n');
});
`;

const echo = () =>
  new Command(process.execPath, ['-e', ECHO], {
    clock: globalThis,
    env: {},
    name: 'Echo',
  });

test('a request gets the value that answers it, in order, from one process', async () => {
  // Arrange
  await using coprocess = new Coprocess(await echo().start());

  // Act
  const first = await coprocess.request({ n: 1 });
  const second = await coprocess.request({ n: 2 });

  // Assert
  assert.deepEqual([first, second], [{ echo: { n: 1 } }, { echo: { n: 2 } }]);
});

test('a caller can receive many values for one it sent', async () => {
  // Arrange
  await using coprocess = new Coprocess(await echo().start());

  // Act
  coprocess.send({ many: true });
  const steps = [
    await coprocess.receive(),
    await coprocess.receive(),
    await coprocess.receive(),
  ];

  // Assert
  assert.deepEqual(steps, [{ step: 1 }, { step: 2 }, { step: 3 }]);
});

test('an end fails the receive that waits and each later receive with the ProcessEndedError that exited() resolves with, holding the end and the stderr tail', async () => {
  // Arrange
  await using coprocess = new Coprocess(await echo().start());
  const stderr = `${'x'.repeat(40_000)}the cause`;
  const tail = stderr.slice(-16_384);

  // Act
  const waiting = await coprocess
    .request({ exit: 3, stderr })
    .catch((error: unknown) => error);
  const later = await coprocess.receive().catch((error: unknown) => error);
  const exited = await coprocess.exited();

  // Assert
  assert.ok(exited instanceof ProcessEndedError);
  assert.equal(
    exited.message,
    `Echo ended (exit code 3) before it sent a line: ${tail}`,
  );
  assert.deepEqual(exited.end, { exitCode: 3 });
  assert.equal(exited.stderr, tail);
  assert.equal(waiting, exited);
  assert.equal(later, exited);
});

test('a line that is not JSON fails only its receive, and the next line still arrives', async () => {
  // Arrange
  await using coprocess = new Coprocess(await echo().start());

  // Act
  const garbage = coprocess.request({ garbage: true });

  // Assert
  await assert.rejects(garbage, (error) => {
    assert.ok(Error.isError(error));
    assert.ok(!(error instanceof ProcessEndedError));
    assert.equal(error.message, 'Echo gave a line that is not JSON');
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
  assert.deepEqual(await coprocess.request({ n: 1 }), { echo: { n: 1 } });
});

test('close() ends stdin and resolves with the end of the process, and exited() then resolves with that end', async () => {
  // Arrange
  await using coprocess = new Coprocess(await echo().start());
  assert.deepEqual(await coprocess.request({ n: 1 }), { echo: { n: 1 } });

  // Act
  const end = await coprocess.close();

  // Assert
  assert.deepEqual(end, { exitCode: 0 });
  assert.ok(coprocess.process.stdin.writableEnded);
  const exited = await coprocess.exited();
  assert.ok(exited instanceof ProcessEndedError);
  assert.deepEqual(exited.end, { exitCode: 0 });
});

test('the disposal stops the process group and resolves after its end', async () => {
  // Arrange
  const started = await echo().start();
  const group = groupOf(started.pid);

  let ended = false;
  void started.ended.then(() => {
    ended = true;
  });

  // Act
  {
    await using coprocess = new Coprocess(started);
    assert.deepEqual(await coprocess.request({ n: 1 }), { echo: { n: 1 } });
  }

  // Assert
  assert.equal(ended, true);
  assert.equal(groupExists(group), false);
  assert.deepEqual(await started.ended, { signal: 'SIGTERM' });
});

test('the lines come before the end: a value written before receive() was called, also one written just before the end, still arrives, and only then the end', async () => {
  // Arrange
  await using coprocess = new Coprocess(await echo().start());
  coprocess.send({ many: true });
  coprocess.send({ exit: 0, last: { n: 'last' } });
  const exited = await coprocess.exited();

  // Act
  const values = [
    await coprocess.receive(),
    await coprocess.receive(),
    await coprocess.receive(),
    await coprocess.receive(),
  ];
  const after = await coprocess.receive().catch((error: unknown) => error);

  // Assert
  assert.deepEqual(values, [
    { step: 1 },
    { step: 2 },
    { step: 3 },
    { n: 'last' },
  ]);
  assert.equal(after, exited);
});

test('a coprocess and another reader of lines() each get every line', async () => {
  // Arrange
  const started = await echo().start();
  await using coprocess = new Coprocess(started);
  const reader = started.lines()[Symbol.asyncIterator]();

  // Act
  const first = await coprocess.request({ n: 1 });
  coprocess.send({ n: 2 });
  const read = [await reader.next(), await reader.next()];
  const second = await coprocess.receive();

  // Assert
  assert.deepEqual([first, second], [{ echo: { n: 1 } }, { echo: { n: 2 } }]);
  assert.deepEqual(
    read.map(({ value }) => value),
    ['{"echo":{"n":1}}', '{"echo":{"n":2}}'],
  );
});

const SENDS: readonly {
  readonly when: string;
  readonly code: string;
  readonly act: (coprocess: Coprocess) => void;
}[] = [
  {
    when: 'while the process ends, past the pipe buffer',
    code: 'EPIPE',
    act: (coprocess: Coprocess) => {
      coprocess.send({ exit: 0 });
      for (let sent = 0; sent < 100; sent++)
        coprocess.send({ padding: 'x'.repeat(10_000) });
    },
  },
  {
    when: 'after stdin.end()',
    code: 'ERR_STREAM_WRITE_AFTER_END',
    act: (coprocess: Coprocess) => {
      coprocess.process.stdin.end();
      coprocess.send({ n: 1 });
    },
  },
];

// The failed write emits 'error' on stdin; the listener that execa 10 keeps on stdin takes it.
void test.each(SENDS, ({ when, code, act }) =>
  test(`a send ${when} fails its write with ${code} and does not crash this process, and the end reports what happened`, async () => {
    // Arrange
    await using coprocess = new Coprocess(await echo().start());
    const { stdin } = coprocess.process;
    // A listener of 'close' only: events.once would add an 'error' listener of its own.
    const closed = new Promise((resolve) => stdin.once('close', resolve));
    const uncaught: unknown[] = [];
    const record = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', record);

    try {
      // Act
      act(coprocess);
      await closed;
      const exited = await coprocess.exited();

      // Assert
      assert.equal(stdin.destroyed, true);
      assert.equal(Reflect.get(Object(stdin.errored), 'code'), code);
      assert.deepEqual(uncaught, []);
      assert.deepEqual(exited.end, { exitCode: 0 });
      assert.equal(
        await coprocess.receive().catch((error: unknown) => error),
        exited,
      );
    } finally {
      process.off('uncaughtException', record);
    }
  }),
);

void test.each(
  [
    {
      how: 'process.stop()',
      stop: (coprocess: Coprocess) => coprocess.process.stop(),
    },
    {
      how: 'the disposal',
      stop: (coprocess: Coprocess) => coprocess[Symbol.asyncDispose](),
    },
  ],
  ({ how, stop }) =>
    test(`a stop by ${how} while a receive waits rejects it with ProcessEndedError whose end is SIGTERM`, async () => {
      // Arrange
      await using coprocess = new Coprocess(await echo().start());
      assert.deepEqual(await coprocess.request({ hang: true }), {
        hanging: true,
      });
      const waiting = coprocess.receive().catch((error: unknown) => error);

      // Act
      await stop(coprocess);

      // Assert
      const error = await waiting;
      assert.ok(error instanceof ProcessEndedError);
      assert.deepEqual(error.end, { signal: 'SIGTERM' });
      assert.equal(error.message, 'Echo ended (SIGTERM) before it sent a line');
      await assert.doesNotReject(coprocess[Symbol.asyncDispose]());
    }),
);

test('new Coprocess(process) takes only a process with stdin and stdout piped', async () => {
  // Arrange
  await using noStdin = await echo().start({ stdin: 'ignore' });
  await using noStdout = await echo().start({ stdout: 'ignore' });

  // Act
  // node --test strips the types: the typecheck target proves the @ts-expect-error lines.
  // @ts-expect-error with stdin 'ignore', the process has no stdin to send to
  const withoutStdin = new Coprocess(noStdin);
  // @ts-expect-error with stdout 'ignore', the process has no lines to receive
  const withoutStdout = new Coprocess(noStdout);

  // Assert
  assert.equal(withoutStdin.process, noStdin);
  assert.equal(withoutStdout.process, noStdout);
});
