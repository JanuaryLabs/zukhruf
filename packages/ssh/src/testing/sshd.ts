import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { TemporaryFiles, isErrno } from '@zukhruf/fs';

const sshdPath = '/usr/sbin/sshd';
const run = promisify(execFile);

export interface Sshd extends AsyncDisposable {
  /** The port on 127.0.0.1 where each connection gets its own `sshd -i`. */
  readonly port: number;
  /** The path of the private key that the server accepts for this user. */
  readonly userKey: string;
  /** The public host key, as one `ssh-ed25519 AAAA…` line. */
  readonly hostPublicKey: string;
  /** The temporary directory that holds the keys and the config. */
  readonly directory: string;
  /** Sends the signal to the `sshd -i` of each open connection. */
  kill(signal: NodeJS.Signals): void;
}

/**
 * A real OpenSSH server for one test, with no root and no fixed port: a
 * `node:net` server on 127.0.0.1 port 0 starts `/usr/sbin/sshd -i` in inetd
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
      [hostKey, userKey].map((file) =>
        run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]),
      ),
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

    const children = new Set<ChildProcess>();
    const server = createServer({ pauseOnConnect: true }, (socket) => {
      const child = spawn(sshdPath, ['-i', '-f', config], {
        stdio: [socket, socket, 'ignore'],
      });
      // The child holds its own copy of the socket; the server's copy would
      // keep the connection open after sshd exits.
      socket.destroy();
      children.add(child);
      child.once('exit', () => children.delete(child));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    return {
      port: portOf(server),
      userKey,
      hostPublicKey,
      directory: directory.path,
      kill(signal) {
        for (const child of children) child.kill(signal);
      },
      async [Symbol.asyncDispose]() {
        const closed = once(server, 'close');
        server.close();
        await Promise.all(
          [...children].map(async (child) => {
            const exited = once(child, 'exit');
            child.kill('SIGTERM');
            // A test may have stopped it; a stopped process ends only after
            // it continues.
            child.kill('SIGCONT');
            await exited;
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

async function testConfig(config: string): Promise<void> {
  try {
    await run(sshdPath, ['-t', '-f', config]);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw new Error(
        `The OpenSSH server ${sshdPath} is missing; install OpenSSH's sshd (openssh-server) to run these tests.`,
        { cause: error },
      );
    }
    throw error;
  }
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server listens on no TCP port.');
  }
  return address.port;
}
