import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';

import { poll } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';

import {
  Command,
  type Message,
  type MessageMatch,
  NodeCommand,
  type NodeCommandOptions,
  ProcessEndedError,
} from './index.ts';
import {
  groupExists,
  groupOf,
  killGroup,
  pidIn,
  pidsIn,
  running,
} from './testing/processes.ts';

const index = import.meta.resolve('./index.ts');

const node = (source: string, options: Partial<NodeCommandOptions> = {}) =>
  new NodeCommand(source, {
    clock: globalThis,
    env: {},
    name: 'the helper',
    ...options,
  });

/** A type and a function that select the message 'held', and the wait that each names. */
const HELD = [
  ["the type 'held'", 'held', "before it sent 'held'"],
  [
    'a function',
    (message: Message) => message.type === 'held',
    'before it sent a selected message',
  ],
] as const satisfies readonly (readonly [string, MessageMatch, string])[];

void test.each(HELD, ([name, match, before]) =>
  test(`next(${name}) that waits rejects with ProcessEndedError when the process ends first, with the end and the stderr tail, never the source`, async (t) => {
    // Arrange
    await using started = await node(
      `const token = 'secret'; process.send({ type: 'waiting' });
       process.once('message', () => { process.stderr.write('no lock'); process.exit(3); });`,
    ).start();
    const next = started.next(match, { signal: t.signal });

    // Act
    started.send({ type: 'go' });

    // Assert
    await assert.rejects(next, (error) => {
      assert.ok(error instanceof ProcessEndedError);
      assert.deepEqual(error.end, { exitCode: 3 });
      assert.equal(error.stderr, 'no lock');
      assert.equal(
        error.message,
        `the helper ended (exit code 3) ${before}: no lock`,
      );
      return true;
    });
  }),
);

void test.each(HELD, ([name, match, before]) =>
  test(`next(${name}) called after the end rejects with ProcessEndedError`, async (t) => {
    // Arrange
    await using started = await node(
      "process.send({ type: 'other' }); process.exitCode = 5;",
    ).start();
    await started.process.ended;

    // Act
    const next = started.next(match, { signal: t.signal });

    // Assert
    await assert.rejects(next, (error) => {
      assert.ok(error instanceof ProcessEndedError);
      assert.equal(error.message, `the helper ended (exit code 5) ${before}`);
      return true;
    });
  }),
);

test('a message sent before the end resolves a next called after the end', async (t) => {
  // Arrange
  await using started = await node(
    "process.send({ type: 'held', by: 7 }); process.exitCode = 0;",
  ).start();
  await started.process.ended;

  // Act
  const message = await started.next('held', { signal: t.signal });

  // Assert
  assert.deepEqual(message, { type: 'held', by: 7 });
});

test('a message sent just before the end resolves a next that already waits', async (t) => {
  // Arrange
  await using started = await node(
    "process.send({ type: 'waiting' }); process.once('message', () => process.send({ type: 'held' }, () => process.exit(0)));",
  ).start();
  await started.next('waiting', { signal: t.signal });
  const next = started.next('held', { signal: t.signal });

  // Act
  started.send({ type: 'go' });

  // Assert
  assert.deepEqual(await next, { type: 'held' });
});

test('every message that the process sent is in messages when ended settles', async () => {
  // Arrange
  await using started = await node(
    "for (let i = 0; i < 200; i++) process.send({ type: 'tick', i });",
  ).start();

  // Act
  await started.process.ended;

  // Assert
  assert.deepEqual(
    started.messages.map((message) => message['i']),
    Array.from({ length: 200 }, (_, i) => i),
  );
});

test('next with a signal that is already aborted rejects with its reason at once, also when the message is there', async (t) => {
  // Arrange
  await using started = await node(
    "process.send({ type: 'held' }); setInterval(() => {}, 1000);",
  ).start();
  await started.next('held', { signal: t.signal });
  const reason = new Error('gave up');

  // Act
  const next = started.next('held', { signal: AbortSignal.abort(reason) });

  // Assert
  await assert.rejects(next, (error) => error === reason);
});

test('an abort during next rejects with its reason', async (t) => {
  // Arrange
  await using started = await node(
    "process.once('message', () => process.send({ type: 'held' })); setInterval(() => {}, 1000);",
  ).start();
  const controller = new AbortController();
  const reason = new Error('gave up');
  const settled: string[] = [];
  const next = started.next('held', { signal: controller.signal }).then(
    () => settled.push('resolved'),
    (error: unknown) => settled.push(error === reason ? 'reason' : 'other'),
  );

  // Act
  controller.abort(reason);
  await next;
  started.send({ type: 'go' });
  await started.next('held', { signal: t.signal });

  // Assert
  assert.deepEqual(settled, ['reason']);
});

test('a next that waits on the end of a live process that closed its channel rejects with the reason of an abort', async (t) => {
  // Arrange
  await using started = await node(
    "process.send({ type: 'other' }); process.disconnect(); setInterval(() => {}, 1000);",
  ).start({ ready: { message: 'other' } });
  const controller = new AbortController();
  const reason = new Error('gave up');
  const next = started.next('held', { signal: controller.signal });
  await poll(
    async () => {
      try {
        started.send({ type: 'probe' });
        return undefined;
      } catch (error) {
        if (Reflect.get(Object(error), 'code') !== 'ERR_IPC_CHANNEL_CLOSED')
          throw error;
        return true;
      }
    },
    { interval: 10, clock: globalThis, signal: t.signal },
  );

  // Act
  controller.abort(reason);

  // Assert
  await assert.rejects(next, (error) => error === reason);
});

test('next resolves with a message sent before the call and with one sent after it', async (t) => {
  // Arrange
  await using started = await node(
    "process.send({ type: 'first' }); process.once('message', () => process.send({ type: 'second' })); setInterval(() => {}, 1000);",
  ).start();
  await poll(async () => (started.messages.length > 0 ? true : undefined), {
    interval: 10,
    clock: globalThis,
    signal: t.signal,
  });
  const first = await started.next('first', { signal: t.signal });
  const second = started.next('second', { signal: t.signal });

  // Act
  started.send({ type: 'go' });

  // Assert
  assert.deepEqual(
    [first, await second],
    [{ type: 'first' }, { type: 'second' }],
  );
});

test('a function of next sees each message once, in the order sent, so it can count to the third tick', async (t) => {
  // Arrange
  await using started = await node(
    "process.send({ type: 'tick', n: 1 }); process.send({ type: 'tick', n: 2 }); setTimeout(() => { for (let n = 3; n <= 5; n++) process.send({ type: 'tick', n }); }, 100); setInterval(() => {}, 1000);",
  ).start();
  await started.next((message) => message['n'] === 2, { signal: t.signal });
  const seen: unknown[] = [];

  // Act
  const third = await started.next(
    (message) => {
      seen.push(message['n']);
      return seen.length === 3;
    },
    { signal: t.signal },
  );

  // Assert
  assert.deepEqual([seen, third], [[1, 2, 3], { type: 'tick', n: 3 }]);
});

test('messages holds each message so far, in order; a value with no string type is not kept and never selected', async (t) => {
  // Arrange
  await using started = await node(
    `process.send({ type: 'a' }); process.send('raw'); process.send({ type: 3 }); process.send({ kind: 'x' }); process.send(null);
     process.send({ type: 'b' }); setInterval(() => {}, 1000);`,
  ).start();

  // Act
  const seen: unknown[] = [];
  await started.next(
    (message) => {
      seen.push(message);
      return message.type === 'b';
    },
    { signal: t.signal },
  );

  // Assert
  assert.deepEqual(
    [started.messages, seen],
    [
      [{ type: 'a' }, { type: 'b' }],
      [{ type: 'a' }, { type: 'b' }],
    ],
  );
});

test('start({ ready: { message } }) resolves at the first selected message, which stays in messages for a later next', async (t) => {
  // Act
  await using started = await node(
    "setTimeout(() => process.send({ type: 'held', by: 1 }), 200); setInterval(() => {}, 1000);",
  ).start({ ready: { message: 'held' } });

  // Assert
  const messages = [...started.messages];
  assert.deepEqual(
    [messages, await started.next('held', { signal: t.signal })],
    [[{ type: 'held', by: 1 }], { type: 'held', by: 1 }],
  );
});

test('a ready function sees each message once, in the order sent', async () => {
  // Arrange
  const seen: unknown[] = [];

  // Act
  await using started = await node(
    "for (let n = 1; n <= 3; n++) setTimeout(() => process.send({ type: 'tick', n }), n * 50); setInterval(() => {}, 1000);",
  ).start({
    ready: {
      message: (message) => {
        seen.push(message['n']);
        return message['n'] === 3;
      },
    },
  });

  // Assert
  assert.deepEqual(seen, [1, 2, 3]);
});

test('a source that throws before its ready message rejects the start with ProcessEndedError, whose stderr holds the thrown error', async () => {
  // Act
  const started = node(
    "const token = 'secret'; throw new Error('config missing');",
  ).start({ ready: { message: 'held' } });

  // Assert
  await assert.rejects(started, (error) => {
    assert.ok(error instanceof ProcessEndedError);
    assert.deepEqual(error.end, { exitCode: 1 });
    assert.match(error.stderr, /Error: config missing/);
    assert.match(
      error.message,
      /^the helper ended \(exit code 1\) before it was ready: /,
    );
    return true;
  });
});

test('an abort before the ready message rejects the start with its reason, and the group is empty when it settles', async (t) => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  const pids = join(folder.path, 'pids');
  const controller = new AbortController();
  const reason = new Error('gave up');
  const started = node(
    `(await import('node:fs')).writeFileSync(${JSON.stringify(pids)}, process.pid + '\\n'); setInterval(() => {}, 1000);`,
  ).start({ ready: { message: 'held' }, signal: controller.signal });
  const pgid = groupOf(await pidIn(pids, t.signal));
  try {
    // Act
    controller.abort(reason);

    // Assert
    await assert.rejects(started, (error) => error === reason);
    assert.equal(groupExists(pgid), false);
  } finally {
    killGroup(pgid);
  }
});

test('a ready function that throws rejects the start with its error, and the group is empty when it settles', async () => {
  // Arrange
  const boom = new Error('cannot read the message');
  const groups: number[] = [];

  // Act
  const started = node(
    "process.send({ type: 'held' }); setInterval(() => {}, 1000);",
  ).start({
    admit: (child) => {
      if (child.pid !== undefined) groups.push(child.pid);
    },
    ready: {
      message: () => {
        throw boom;
      },
    },
  });

  // Assert
  try {
    await assert.rejects(started, (error) => error === boom);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups.map(groupExists), [false]);
  } finally {
    groups.forEach(killGroup);
  }
});

test('an abort after the ready message stops the process, and its end is SIGTERM', async () => {
  // Arrange
  const controller = new AbortController();
  await using started = await node(
    "process.send({ type: 'held' }); setInterval(() => {}, 1000);",
  ).start({ ready: { message: 'held' }, signal: controller.signal });

  // Act
  controller.abort(new Error('done'));

  // Assert
  assert.deepEqual(await started.process.ended, { signal: 'SIGTERM' });
});

test('start({ ready: { line } }) of a NodeCommand resolves at that line of stdout', async () => {
  // Arrange
  const startedAt = performance.now();

  // Act
  await using started = await node(
    "setTimeout(() => console.log('listening'), 300); setInterval(() => {}, 1000);",
  ).start({ ready: { line: 'listening' } });

  // Assert
  assert.ok(performance.now() - startedAt >= 300);
  assert.equal(
    (await started.process.lines()[Symbol.asyncIterator]().next()).value,
    'listening',
  );
});

test('send(message) reaches process.on(message) of the source', async (t) => {
  // Arrange
  await using started = await node(
    "process.on('message', (message) => process.send({ type: 'echo', message }));",
  ).start();

  // Act
  started.send({ type: 'ping', n: 1 });

  // Assert
  assert.deepEqual(await started.next('echo', { signal: t.signal }), {
    type: 'echo',
    message: { type: 'ping', n: 1 },
  });
});

test('send after the end throws ERR_IPC_CHANNEL_CLOSED at the call', async () => {
  // Arrange
  await using started = await node('process.exitCode = 0;').start();
  await started.process.ended;

  // Act
  const send = () => started.send({ type: 'late' });

  // Assert
  assert.throws(send, { code: 'ERR_IPC_CHANNEL_CLOSED' });
});

test('admit gets the IPC-carrying ChildProcess, and a listener that it attaches sees the first message, sent at once', async (t) => {
  // Arrange
  const seen: unknown[] = [];
  const children: unknown[] = [];

  // Act
  await using started = await node(
    "process.send({ type: 'first' }); setInterval(() => {}, 1000);",
  ).start({
    admit: (child) => {
      children.push(child);
      child.on('message', (message) => seen.push(message));
    },
  });
  await started.next('first', { signal: t.signal });

  // Assert
  assert.equal(children.length, 1);
  assert.ok(children[0] instanceof ChildProcess);
  assert.deepEqual(seen, [{ type: 'first' }]);
});

test('an admit that throws rejects the start with its error, and the group is empty when it settles', async () => {
  // Arrange
  const refused = new Error('the coordinator is full');
  const groups: number[] = [];

  // Act
  const started = node('setInterval(() => {}, 1000);').start({
    admit: (child) => {
      if (child.pid !== undefined) groups.push(child.pid);
      throw refused;
    },
  });

  // Assert
  try {
    await assert.rejects(started, (error) => error === refused);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups.map(groupExists), [false]);
  } finally {
    groups.forEach(killGroup);
  }
});

test('run() runs the source to its end and gives its exit code, stdout and stderr, with no throw at a non-zero exit', async () => {
  // Act
  const completed = await node(
    "process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exitCode = 4;",
  ).run();

  // Assert
  assert.deepEqual(
    {
      exitCode: completed.exitCode,
      stdout: completed.stdout,
      stderr: completed.stderr,
      output: completed.output.split('\n').sort(),
    },
    {
      exitCode: 4,
      stdout: 'out\n',
      stderr: 'err\n',
      output: ['', 'err', 'out'],
    },
  );
});

test('run() keeps an IPC channel: process.send in the source does not throw', async () => {
  // Act
  const completed = await node(
    "process.send({ type: 'done' }); console.log(typeof process.send);",
  ).run();

  // Assert
  assert.deepEqual([completed.exitCode, completed.stdout], [0, 'function\n']);
});

test('run({ input }) writes the input to stdin of the source', async () => {
  // Act
  const completed = await node(
    "let text = ''; for await (const chunk of process.stdin) text += chunk; console.log(text.toUpperCase());",
  ).run({ input: 'hello' });

  // Assert
  assert.equal(completed.stdout, 'HELLO\n');
});

test('an abort of run() rejects with its reason once the group is empty', async (t) => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  const pids = join(folder.path, 'pids');
  const controller = new AbortController();
  const reason = new Error('gave up');
  const run = node(
    `(await import('node:fs')).writeFileSync(${JSON.stringify(pids)}, process.pid + '\\n'); setInterval(() => {}, 1000);`,
  ).run({ signal: controller.signal });
  const pgid = groupOf(await pidIn(pids, t.signal));
  try {
    // Act
    controller.abort(reason);

    // Assert
    await assert.rejects(run, (error) => error === reason);
    assert.equal(groupExists(pgid), false);
  } finally {
    killGroup(pgid);
  }
});

test('nodeOptions come before the source, in start and in run: the source sees them first in process.execArgv', async (t) => {
  // Arrange
  const nodeOptions = ['--no-warnings', '--max-old-space-size=128'];
  const command = node(
    "const flags = process.execArgv.slice(0, 3); if (process.send) process.send({ type: 'flags', flags }); console.log(JSON.stringify(flags));",
    { nodeOptions },
  );

  // Act
  await using started = await command.start();
  const sent = await started.next('flags', { signal: t.signal });
  const completed = await command.run();

  // Assert
  const expected = [...nodeOptions, '--input-type=module'];
  assert.deepEqual(
    [sent['flags'], JSON.parse(completed.stdout)],
    [expected, expected],
  );
});

test('the source runs as an ES module: an import and a top-level await work, and a bare import resolves from the folder of the command', async (t) => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  const probe = join(folder.path, 'node_modules', 'zukhruf-probe');
  await mkdir(probe, { recursive: true });
  await writeFile(
    join(probe, 'package.json'),
    JSON.stringify({
      name: 'zukhruf-probe',
      type: 'module',
      exports: './index.js',
    }),
  );
  await writeFile(
    join(probe, 'index.js'),
    "export const answer = 'from the cwd';",
  );

  // Act
  await using started = await node(
    `import { join } from 'node:path';
     import { answer } from 'zukhruf-probe';
     const joined = await Promise.resolve(join('a', 'b'));
     process.send({ type: 'module', joined, answer, require: typeof require });
     setInterval(() => {}, 1000);`,
    { cwd: folder.path },
  ).start();

  // Assert
  assert.deepEqual(await started.next('module', { signal: t.signal }), {
    type: 'module',
    joined: 'a/b',
    answer: 'from the cwd',
    require: 'undefined',
  });
});

test('process.pid is the pid of the Node.js that runs the source: SIGSTOP stops its messages, SIGCONT resumes them, SIGKILL ends it', async (t) => {
  // Arrange
  await using started = await node(
    "process.send({ type: 'pid', pid: process.pid }); setInterval(() => process.send({ type: 'tick' }), 10);",
  ).start({ ready: { message: 'pid' } });
  const { pid } = await started.next('pid', { signal: t.signal });
  assert.equal(started.process.pid, pid);

  // Act
  process.kill(started.process.pid, 'SIGSTOP');
  await setTimeout(100);
  const whileStopped = started.messages.length;
  await setTimeout(200);
  const stopped = started.messages.length - whileStopped;
  process.kill(started.process.pid, 'SIGCONT');
  const from = started.messages.length;
  const resumed = started.next(
    (message) => started.messages.indexOf(message) >= from,
    { signal: t.signal },
  );
  await resumed;
  process.kill(started.process.pid, 'SIGKILL');

  // Assert
  assert.equal(stopped, 0);
  assert.deepEqual(await started.process.ended, { signal: 'SIGKILL' });
});

test('a NodeProcess whose parent is killed with SIGKILL ends, and so does its child', async (t) => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  const pids = join(folder.path, 'pids');
  const source = `const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    (await import('node:fs')).writeFileSync(${JSON.stringify(pids)}, process.pid + '\\n' + child.pid + '\\n');
    setInterval(() => {}, 1000);`;
  const parent = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { NodeCommand } from ${JSON.stringify(index)};
       await new NodeCommand(${JSON.stringify(source)}, { clock: globalThis, env: {} }).start();
       setInterval(() => {}, 1000);`,
    ],
    { stdio: 'ignore' },
  );
  const exited = once(parent, 'exit');
  const [target, child] = await pidsIn(pids, t.signal);
  try {
    // Act
    parent.kill('SIGKILL');
    await exited;

    // Assert
    const gone = await poll(
      async () => (!running(target) && !running(child) ? true : undefined),
      { interval: 20, clock: globalThis, signal: t.signal },
    );
    assert.equal(gone, true);
  } finally {
    for (const pid of [target, child])
      if (running(pid)) process.kill(pid, 'SIGKILL');
  }
});

/** macOS adds this to the environment of each process that it starts (probed 2026-11-27). */
const withoutMacOs = (env: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(env).filter(([name]) => name !== '__CF_USER_TEXT_ENCODING'),
  );

test('the source gets the given environment and nothing else', async (t) => {
  // Arrange
  await using started = await node(
    "process.send({ type: 'env', env: { ...process.env } }); setInterval(() => {}, 1000);",
    { env: { ZUKHRUF_GIVEN: 'yes', ZUKHRUF_LEFT_OUT: undefined } },
  ).start();

  // Act
  const { env } = await started.next('env', { signal: t.signal });

  // Assert
  assert.ok(typeof env === 'object' && env !== null);
  assert.deepEqual(withoutMacOs({ ...env }), { ZUKHRUF_GIVEN: 'yes' });
});

test('the source gets an OLDPWD that is not a folder and a _, which the shell of the keeper would drop or set', async (t) => {
  // Arrange
  await using started = await node(
    "process.send({ type: 'env', env: { ...process.env } }); setInterval(() => {}, 1000);",
    { env: { OLDPWD: '/nonexistent', _: '/x' } },
  ).start();

  // Act
  const { env } = await started.next('env', { signal: t.signal });

  // Assert
  assert.ok(typeof env === 'object' && env !== null);
  assert.deepEqual(withoutMacOs({ ...env }), {
    OLDPWD: '/nonexistent',
    _: '/x',
  });
});

test('with env: process.env, the source gets the whole environment of this process', async (t) => {
  // Arrange
  await using started = await node(
    "process.send({ type: 'env', env: { ...process.env } }); setInterval(() => {}, 1000);",
    { env: process.env },
  ).start();

  // Act
  const { env } = await started.next('env', { signal: t.signal });

  // Assert
  assert.ok(typeof env === 'object' && env !== null);
  assert.deepEqual(withoutMacOs({ ...env }), withoutMacOs({ ...process.env }));
});

test('the disposal stops the group: ended gives SIGTERM, a child of the source ends, and the disposal resolves when stdout has closed', async (t) => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  const pids = join(folder.path, 'pids');
  const started = await node(
    `const { spawn } = await import('node:child_process');
     const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
     (await import('node:fs')).writeFileSync(${JSON.stringify(pids)}, process.pid + '\\n' + child.pid + '\\n');
     console.log('up'); setInterval(() => {}, 1000);`,
  ).start({ ready: { line: 'up' } });
  const [pid, child] = await pidsIn(pids, t.signal);
  const pgid = groupOf(pid);
  try {
    // Act
    await started[Symbol.asyncDispose]();

    // Assert
    const emptied = !groupExists(pgid);
    const childEnded = !running(child);
    const lines = await Array.fromAsync(started.process.lines());
    assert.deepEqual(
      [emptied, childEnded, await started.process.ended, lines],
      [true, true, { signal: 'SIGTERM' }, ['up']],
    );
  } finally {
    killGroup(pgid);
  }
});

test('the disposal resolves after the streams closed: the stderr tail holds the text that a process outside the group writes after the group ended', async () => {
  // Arrange
  const started = await node(
    `const { spawn } = await import('node:child_process');
     process.on('SIGTERM', () => {
       spawn(process.execPath, ['-e', "setTimeout(() => process.stderr.write('MARKER'), 200)"], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] });
       process.exit(0);
     });
     process.send({ type: 'up' }); setInterval(() => {}, 1000);`,
  ).start({ ready: { message: 'up' } });

  // Act
  await started[Symbol.asyncDispose]();

  // Assert
  assert.ok(started.process.stderrTail().endsWith('MARKER'));
});

test('the disposal of a source that ignores SIGTERM sends SIGKILL at the grace on the clock', async () => {
  // Arrange
  const clock = createClock();
  const started = await node(
    "process.on('SIGTERM', () => {}); process.send({ type: 'up' }); setInterval(() => {}, 1000);",
    { clock, grace: 3000 },
  ).start({ ready: { message: 'up' } });

  // Act
  const disposed = started[Symbol.asyncDispose]();
  const killedAt = await clock.nextAsync();
  await disposed;

  // Assert
  assert.deepEqual(
    [killedAt, await started.process.ended],
    [3000, { signal: 'SIGKILL' }],
  );
});

test('a second disposal and a disposal after the end resolve', async () => {
  // Arrange
  const live = await node('setInterval(() => {}, 1000);').start();
  const ended = await node('process.exitCode = 2;').start();
  await ended.process.ended;

  // Act
  await live[Symbol.asyncDispose]();
  await live[Symbol.asyncDispose]();
  await ended[Symbol.asyncDispose]();

  // Assert
  assert.deepEqual(
    [await live.process.ended, await ended.process.ended],
    [{ signal: 'SIGTERM' }, { exitCode: 2 }],
  );
});

test('process of a NodeProcess is a PipedProcess: stdin reaches the source, and lines() gives its stdout', async () => {
  // Arrange
  await using started = await node(
    "process.stdin.on('data', (chunk) => console.log('got ' + String(chunk).trim()));",
  ).start();

  // Act
  started.process.stdin.write('hello\n');

  // Assert
  const first = await started.process.lines()[Symbol.asyncIterator]().next();
  assert.equal(first.value, 'got hello');
});

test('the name is argv[1] of the source and names the process in each error', async (t) => {
  // Arrange
  await using started = await node(
    "process.send({ type: 'argv', name: process.argv[1] }); process.once('message', () => process.exit(1));",
  ).start();
  const { name } = await started.next('argv', { signal: t.signal });

  // Act
  started.send({ type: 'end' });
  const next = started.next('never', { signal: t.signal });

  // Assert
  assert.equal(name, 'the helper');
  await assert.rejects(next, /^ProcessEndedError: the helper ended/);
});

test('with no name, the name is the file of Node.js, as for a command', async (t) => {
  // Arrange
  await using started = await new NodeCommand(
    "process.send({ type: 'argv', name: process.argv[1] }); process.once('message', () => process.exit(1));",
    { clock: globalThis, env: {} },
  ).start();
  const { name } = await started.next('argv', { signal: t.signal });

  // Act
  started.send({ type: 'end' });
  const next = started.next('never', { signal: t.signal });

  // Assert
  assert.equal(name, process.execPath);
  await assert.rejects(next, (error) => {
    assert.ok(error instanceof ProcessEndedError);
    assert.ok(error.message.startsWith(`${process.execPath} ended`));
    return true;
  });
});

test('(types) a ready message and admit exist only on NodeCommand#start; a Process has no next or messages; send needs a string type; next needs a signal', async () => {
  // Arrange: only the type checker refuses these calls, so they run a file that ends at once.
  const ends = new Command('/usr/bin/true', [], { clock: globalThis, env: {} });
  await using started = await node('process.exitCode = 0;').start();

  // Act
  // @ts-expect-error a command's process has no IPC channel, so no ready message
  const readyMessage = ends.start({ ready: { message: 'held' } });
  const refusedAtTheEnd = assert.rejects(readyMessage, ProcessEndedError);
  // @ts-expect-error a command's process has no IPC channel to admit
  await using admitted = await ends.start({ admit: () => {} });

  // Assert
  await refusedAtTheEnd;
  // @ts-expect-error a Process has no next
  assert.equal(admitted.next, undefined);
  // @ts-expect-error a Process has no messages
  assert.equal(started.process.messages, undefined);
  await started.process.ended;
  // @ts-expect-error a message is an object with a string type
  assert.throws(() => started.send('raw'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
  // @ts-expect-error a type must be a string
  assert.throws(() => started.send({ type: 3 }), {
    code: 'ERR_IPC_CHANNEL_CLOSED',
  });
  // @ts-expect-error a message needs a type
  assert.throws(() => started.send({ kind: 'x' }), {
    code: 'ERR_IPC_CHANNEL_CLOSED',
  });
  // Never called: only the type checker reads these.
  const unsignalled = () => [
    // @ts-expect-error next needs a signal
    started.next('held'),
    // @ts-expect-error next needs a signal, also in its options
    started.next('held', {}),
  ];
  void unsignalled;
});
