import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';

import {
  Client,
  ExitError,
  ExitMissingError,
  OpenChannelError,
  PrivateKey,
} from './index.ts';
import { dial } from './testing/dial.ts';
import { type Sshd, startSshd } from './testing/sshd.ts';

const noSshd = process.platform === 'win32' ? 'Windows has no sshd' : false;

test(
  'run of a command that exits with a status other than 0 rejects with ExitError, whose exit holds the status',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);

    // Act
    const ran = client.newSession().run('exit 3');

    // Assert
    await assert.rejects(ran, (error) => {
      assert.ok(error instanceof ExitError);
      assert.deepEqual(error.exit, { kind: 'status', exitStatus: 3 });
      return true;
    });
  },
);

test(
  'a session whose channel sshd refuses under MaxSessions 0 rejects with OpenChannelError, whose reason is connect-failed, as sshd sends it',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd({ config: ['MaxSessions 0'] });
    await using client = await dial(sshd);

    // Act
    const ran = client.newSession().output('true');

    // Assert
    await assert.rejects(ran, (error) => {
      assert.ok(error instanceof OpenChannelError);
      assert.deepEqual(
        { reason: error.reason, description: error.description },
        { reason: 'connect-failed', description: 'open failed' },
      );
      return true;
    });
  },
);

test(
  'run of a command that exits with status 0 resolves',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);

    // Act
    const ran = client.newSession().run('exit 0');

    // Assert
    await ran;
  },
);

test(
  'run of a command that a signal ended rejects with ExitError, whose exit holds the signal with no SIG',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);

    // Act
    const ran = client.newSession().run('kill -KILL $$');

    // Assert
    await assert.rejects(ran, (error) => {
      assert.ok(error instanceof ExitError);
      assert.deepEqual(error.exit, {
        kind: 'signal',
        signal: 'KILL',
        coreDumped: false,
        errorMessage: '',
      });
      return true;
    });
  },
);

test(
  'a signal outside the list of RFC 4254 gives the vendor name that sshd sends',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);

    // Act
    const ran = client.newSession().run('kill -VTALRM $$');

    // Assert
    await assert.rejects(ran, (error) => {
      assert.ok(error instanceof ExitError);
      assert.equal(error.exit.kind, 'signal');
      assert.equal(
        error.exit.kind === 'signal' && error.exit.signal,
        'SIG@openssh.com',
      );
      return true;
    });
  },
);

test(
  'wait rejects with ExitMissingError when the channel closes with no exit status, as when the server process dies',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    const session = client.newSession();

    // Act: the parent of the command is the sshd process of the session.
    await session.start('kill -KILL $PPID; exec sleep 1');

    // Assert
    await assert.rejects(session.wait(), ExitMissingError);
  },
);

test(
  'when the lost connection ends the session, ExitMissingError has the error that ended the connection as its cause',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    const session = client.newSession();
    const ended = client.wait().then(
      () => assert.fail('the connection ended with no error'),
      (error: unknown) => error,
    );

    // Act: the sshd process of the session dies, and its socket closes.
    await session.start('kill -KILL $PPID; exec sleep 1');

    // Assert
    const missing = await session.wait().then(
      () => assert.fail('the session exited'),
      (error: unknown) => error,
    );
    assert.ok(missing instanceof ExitMissingError);
    assert.ok(Error.isError(missing.cause));
    assert.equal(missing.cause, await ended);
  },
);

test(
  'output gives the stdout of the command and not its stderr',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);

    // Act
    const output = await client
      .newSession()
      .output('printf out; printf err >&2');

    // Assert
    assert.equal(output.toString(), 'out');
  },
);

test(
  'combinedOutput gives stdout and stderr in the order they came',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);

    // Act
    const output = await client
      .newSession()
      .combinedOutput('printf 1; sleep 0.2; printf 2 >&2; sleep 0.2; printf 3');

    // Assert
    assert.equal(output.toString(), '123');
  },
);

test(
  'start streams stdin to the command, its end is the end of input, and stdout gives what the command wrote',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    await using session = client.newSession();
    session.stdin.write('before the start\n');

    // Act
    await session.start('tr a-z A-Z');
    session.stdin.end('after the start\n');
    const read = text(session.stdout);

    // Assert
    assert.equal(await read, 'BEFORE THE START\nAFTER THE START\n');
    await session.wait();
  },
);

test(
  'a command that exits without reading all of its stdin: wait() resolves with its exit status, stdout gives what it wrote, and the writer of stdin fails with the close of the channel',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    await using session = client.newSession();
    const read = text(session.stdout);
    await session.start('head -c1');
    // Input with no end: once the window of sshd's session channel (2 MB,
    // CHAN_SES_WINDOW_DEFAULT in OpenSSH's channels.h) is full, a write waits
    // for window when the command exits.
    const chunk = Buffer.alloc(64 * 1024, 'a');
    const input = Readable.from(
      (function* () {
        for (;;) yield chunk;
      })(),
    );

    // Act
    const written = pipeline(input, session.stdin);

    // Assert
    const writeFailed = assert.rejects(written, {
      message: 'ssh: the channel is closed',
    });
    await session.wait();
    assert.equal(await read, 'a');
    await writeFailed;
  },
);

test(
  'a write to stdin after the channel closed fails the writer with the close of the channel, and is not dropped',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    await using session = client.newSession();
    const read = text(session.stdout);
    await session.start('true');
    await session.wait();
    // The stream of the channel closes at the end of stdout, with no write
    // waiting.
    assert.equal(await read, '');

    // Act
    const written = pipeline(
      Readable.from(['after the close\n']),
      session.stdin,
    );

    // Assert
    await assert.rejects(written, { message: 'ssh: the channel is closed' });
  },
);

test(
  'stdin carries more than the window of the channel, whole, to a command that reads all of it',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    await using session = client.newSession();
    const read = text(session.stdout);
    await session.start('wc -c');
    // 4 MiB: more than the 2 MB window of sshd's session channel, so writes
    // wait for window and for the drain of the stream.
    const chunk = Buffer.alloc(64 * 1024, 'a');
    const input = Readable.from(Array.from({ length: 64 }, () => chunk));

    // Act
    await pipeline(input, session.stdin);
    await session.wait();

    // Assert
    assert.equal((await read).trim(), String(64 * chunk.length));
  },
);

test(
  'stdin pushes back on a writer that writes faster than the channel takes: write() returns false, so an endless writer does not fill the memory',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    await using session = client.newSession();
    await session.start('cat > /dev/null');
    const chunk = Buffer.alloc(64 * 1024, 'a');
    const limit = 64 * 1024 * 1024;

    // Act: the writes go in one turn of the event loop, before the channel
    // sends anything.
    let accepted = 0;
    while (accepted < limit && session.stdin.write(chunk)) {
      accepted += chunk.length;
    }

    // Assert
    assert.ok(accepted < limit);
    // stdin still holds data, which the close of the session would fail.
    session.stdin.end();
    await session.wait();
  },
);

test(
  'run discards output that nothing reads, so a command with more output than the buffers ends',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);

    // Act
    const ran = client.newSession().run('head -c 4000000 /dev/zero');

    // Assert
    await ran;
  },
);

test(
  'the variables of sessionEnv and of setenv reach the command, and setenv wins for a name in both',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd({ config: ['AcceptEnv ZUKHRUF_*'] });
    await using client = await dial(sshd, {
      sessionEnv: {
        ZUKHRUF_CONFIG: 'from the config',
        ZUKHRUF_BOTH: 'from the config',
      },
    });
    const session = client.newSession();
    session.setenv('ZUKHRUF_BOTH', 'from setenv');

    // Act
    const output = await session.output(
      'printf "%s|%s" "$ZUKHRUF_CONFIG" "$ZUKHRUF_BOTH"',
    );

    // Assert
    assert.equal(output.toString(), 'from the config|from setenv');
  },
);

test(
  'a variable that the server refuses is not set, and the command still runs',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    const session = client.newSession();
    session.setenv('ZUKHRUF_REFUSED', 'value');

    // Act
    const output = await session.output('printf "[%s]" "$ZUKHRUF_REFUSED"');

    // Assert
    assert.equal(output.toString(), '[]');
  },
);

test(
  'requestPty, then shell, runs a login shell on a terminal',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    await using session = client.newSession();
    session.requestPty('xterm', { rows: 24, columns: 80 });

    // Act
    await session.shell();
    session.stdin.write('tty; exit\n');
    const output = await text(session.stdout);

    // Assert
    assert.match(output, /\/dev\/(pts\/|ttys)\d+/);
    await session.wait();
  },
);

test(
  'a pty that the server refuses rejects shell',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd({ config: ['PermitTTY no'] });
    await using client = await dial(sshd);
    await using session = client.newSession();
    session.requestPty('xterm', { rows: 24, columns: 80 });

    // Act
    const shell = session.shell();

    // Assert
    await assert.rejects(shell, /pseudo-terminal/);
  },
);

test(
  'windowChange gives the terminal of the command its new size',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    await using session = client.newSession();
    session.requestPty('xterm', { rows: 24, columns: 80 });
    await session.shell();

    // Act
    await session.windowChange({ rows: 33, columns: 101 });
    session.stdin.write('stty size; exit\n');
    const output = await text(session.stdout);

    // Assert
    assert.match(output, /\b33 101\r\n/);
  },
);

test(
  'signal delivers the signal to the command',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    await using session = client.newSession();
    // start() resolves when the server accepts the command, before sshd has
    // started it: a signal sent at once can find no process group to kill.
    await session.start('echo started; exec sleep 30');
    await once(session.stdout, 'data');

    // Act
    await session.signal('TERM');

    // Assert
    await assert.rejects(session.wait(), (error) => {
      assert.ok(error instanceof ExitError);
      assert.equal(error.exit.kind === 'signal' && error.exit.signal, 'TERM');
      return true;
    });
  },
);

test(
  'wait after a start that the server refused rejects with the same error, and does not hang',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd({ config: ['PermitTTY no'] });
    await using client = await dial(sshd);
    await using session = client.newSession();
    session.requestPty('xterm', { rows: 24, columns: 80 });
    const refusal = await session.start('true').then(
      () => assert.fail('the server accepted the pty'),
      (error: unknown) => error,
    );

    // Act
    const waited = session.wait();

    // Assert
    await assert.rejects(waited, (error) => error === refusal);
  },
);

test(
  'start on a client whose connection closed rejects, and wait then rejects with the same error',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const client = await dial(sshd);
    await client.close();
    const session = client.newSession();

    // Act
    const refusal = await session.start('true').then(
      () => assert.fail('the session started on a closed connection'),
      (error: unknown) => error,
    );

    // Assert
    assert.ok(Error.isError(refusal));
    await assert.rejects(session.wait(), (error) => error === refusal);
  },
);
