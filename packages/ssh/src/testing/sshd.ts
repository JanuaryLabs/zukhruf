import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:net';
import { join } from 'node:path';

import { untilAborted } from '@zukhruf/async';
import { TemporaryFiles, isErrno } from '@zukhruf/fs';
import { Command, ExitError, type Process, StartError } from '@zukhruf/process';

export interface Sshd extends AsyncDisposable {
  /** The port on 127.0.0.1 where each connection gets its own `sshd -i`. */
  readonly port: number;
  /** The path of the private key that the server accepts for this user. */
  readonly userKey: string;
  /** The public host key, as one `ssh-ed25519 AAAA…` line. */
  readonly hostPublicKey: string;
  /** The temporary directory that holds the keys and the config. */
  readonly directory: string;
  /** How many connections the server has accepted so far, each with its own `sshd -i`. */
  connections(): number;
  /** Sends the signal to the `sshd -i` of each open connection. */
  kill(signal: NodeJS.Signals): void;
  /** Resolves when the `sshd -i` of each connection so far has exited. It is the privsep monitor, which exits only after it reaps the child that served the connection (mm_request_receive and mm_reap in OpenSSH's monitor_wrap.c), so no sshd process of the connection is left. */
  connectionsEnded(options: { readonly signal: AbortSignal }): Promise<void>;
}

/**
 * A real OpenSSH server for one test, with no root and no fixed port: a
 * `node:net` server on 127.0.0.1 port 0 starts `sshd -i` of the PATH in inetd
 * mode for each connection, as OpenSSH's regress/test-exec.sh does with its
 * sshd_proxy. The config uses only options that OpenSSH 9.6 knows; `config`
 * adds lines, such as `AcceptEnv LANG`.
 */
export async function startSshd(
  options: { readonly config?: readonly string[] } = {},
): Promise<Sshd> {
  const directory = await new TemporaryFiles().directory('ssh-', {
    parent: '/tmp',
  });
  try {
    const hostKey = join(directory.path, 'host_ed25519');
    const userKey = join(directory.path, 'id_ed25519');
    await Promise.all(
      [hostKey, userKey].map(async (file) => {
        const keygen = await new Command(
          'ssh-keygen',
          ['-q', '-t', 'ed25519', '-N', '', '-f', file],
          { env: process.env, clock: globalThis },
        ).run();
        if (keygen.exitCode !== 0) throw new ExitError('ssh-keygen', keygen);
      }),
    );
    const authorizedKeys = join(directory.path, 'authorized_keys');
    await writeFile(authorizedKeys, await readFile(`${userKey}.pub`));
    const config = join(directory.path, 'sshd_config');
    await writeFile(
      config,
      [
        'StrictModes no',
        'UsePAM no',
        `HostKey ${hostKey}`,
        `AuthorizedKeysFile ${authorizedKeys}`,
        'PidFile none',
        ...(options.config ?? []),
        '',
      ].join('\n'),
    );
    await testConfig(config);
    const hostPublicKey = (await readFile(`${hostKey}.pub`, 'utf8')).trim();

    const inetd = new Command('sshd', ['-i', '-f', config], {
      env: process.env,
      clock: globalThis,
    });
    const starts: Promise<Process>[] = [];
    const running = new Set<Process>();
    const server = createServer({ pauseOnConnect: true }, (socket) => {
      // The child holds its own copy of the socket; the server's copy would
      // keep the connection open after sshd exits.
      const starting = inetd
        .start({ stdin: socket, stdout: socket, stderr: 'ignore' })
        .then((started) => {
          running.add(started);
          void started.ended.then(() => running.delete(started));
          return started;
        })
        .finally(() => socket.destroy());
      starts.push(starting);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    return {
      port: portOf(server),
      userKey,
      hostPublicKey,
      directory: directory.path,
      connections() {
        return starts.length;
      },
      kill(signal) {
        // After the login, sshd forks the child that serves the connection
        // (privsep_postauth in OpenSSH's sshd-session.c); it holds the socket
        // too, so the signal goes to each member of the group.
        for (const started of running) started.signal(signal, { to: 'group' });
      },
      async connectionsEnded({ signal }) {
        await untilAborted(
          Promise.all(starts.map(async (starting) => (await starting).ended)),
          signal,
        );
      },
      async [Symbol.asyncDispose]() {
        const closed = once(server, 'close');
        server.close();
        await Promise.all(
          starts.map(async (starting) => {
            const started = await starting;
            if (!running.has(started)) return;
            // A stop wakes a group that a test froze (process ADR 0014).
            await started.stop();
          }),
        );
        await closed;
        await directory[Symbol.asyncDispose]();
      },
    };
  } catch (error) {
    await directory[Symbol.asyncDispose]();
    throw error;
  }
}

/**
 * Tests the config with the first sshd on the PATH, which each connection
 * then starts, as Go's x/crypto/ssh tests find theirs with
 * `exec.LookPath("sshd")`.
 */
async function testConfig(config: string): Promise<void> {
  const tested = await new Command('sshd', ['-t', '-f', config], {
    env: process.env,
    clock: globalThis,
  })
    .run()
    .catch((error: unknown) => {
      if (error instanceof StartError && isErrno(error.cause, 'ENOENT')) {
        throw new Error(
          "The OpenSSH server sshd is missing from the PATH; install OpenSSH's sshd (openssh-server) to run these tests.",
          { cause: error },
        );
      }
      throw error;
    });
  if (tested.exitCode !== 0) throw new ExitError('sshd', tested);
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server listens on no TCP port.');
  }
  return address.port;
}
