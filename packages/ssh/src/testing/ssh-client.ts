import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { type Server, type Socket, createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';

import { PrivateKey, PublicKey } from '../index.ts';

const run = promisify(execFile);

/** How one `ssh` run ended. */
export interface SshRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SshClientRig extends AsyncDisposable {
  /** The port on 127.0.0.1 where each connection goes to the handler of the test. */
  readonly port: number;
  /** The temporary directory that holds the keys, the known hosts and the config. */
  readonly directory: string;
  readonly hostKey: PrivateKey;
  /** The key that `ssh` offers, from the IdentityFile of its config. */
  readonly userKey: PublicKey;
  /**
   * Runs OpenSSH's `ssh` with `-F <config> -p <port>` against 127.0.0.1, as
   * user `test`. The config trusts only the host key and offers only the user
   * key; `args` come before the host, and `command` after it.
   */
  /** Waits for the handler of each connection so far, and throws the first error of one. */
  handled(): Promise<void>;
  ssh(
    args: readonly string[],
    command: readonly string[],
    options?: {
      readonly input?: string;
      readonly env?: Readonly<Record<string, string>>;
      /** Runs ssh under `script`, so that its stdin is a terminal and it sends the modes of that terminal. The stdin of script is /dev/null: BSD script fails on a socket, and Node's pipes on macOS are sockets. */
      readonly terminal?: boolean;
    },
  ): Promise<SshRun>;
}

/**
 * A `node:net` server on 127.0.0.1 port 0 that gives each accepted socket to
 * `handle`, and the OpenSSH `ssh` client to reach it. The dispose waits for
 * each handler and throws the first error of one.
 */
export async function startSshClientRig(
  handle: (socket: Socket) => Promise<void>,
): Promise<SshClientRig> {
  const directory = await new TemporaryFiles().directory('ssh-server-', {
    parent: '/tmp',
  });
  try {
    const hostKeyFile = join(directory.path, 'host_ed25519');
    const userKeyFile = join(directory.path, 'id_ed25519');
    await Promise.all(
      [hostKeyFile, userKeyFile].map((file) =>
        run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]),
      ),
    );
    const hostKey = PrivateKey.parse(await readFile(hostKeyFile));
    const { key: userKey } = PublicKey.parseAuthorizedKey(
      await readFile(`${userKeyFile}.pub`, 'utf8'),
    );
    const knownHosts = join(directory.path, 'known_hosts');
    await writeFile(knownHosts, `ssh-server-test ${hostKey.publicKey}\n`);
    const config = join(directory.path, 'ssh_config');
    await writeFile(
      config,
      [
        'Host *',
        '  HostKeyAlias ssh-server-test',
        `  UserKnownHostsFile ${knownHosts}`,
        '  GlobalKnownHostsFile /dev/null',
        '  StrictHostKeyChecking yes',
        '  UpdateHostKeys no',
        `  IdentityFile ${userKeyFile}`,
        '  IdentitiesOnly yes',
        '  IdentityAgent none',
        '  ControlMaster no',
        '  ControlPath none',
        '',
      ].join('\n'),
    );

    const handlers: Promise<void>[] = [];
    const server = createServer((socket) => {
      handlers.push(handle(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = portOf(server);
    const handled = async (): Promise<void> => {
      const outcomes = await Promise.allSettled(handlers);
      const failure = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failure !== undefined) throw failure.reason;
    };

    return {
      port,
      directory: directory.path,
      hostKey,
      userKey,
      async ssh(args, command, options = {}) {
        const argv = [
          'ssh',
          '-F',
          config,
          '-p',
          String(port),
          ...args,
          'test@127.0.0.1',
          ...command,
        ];
        const [file, ...fileArgs] = options.terminal ? underScript(argv) : argv;
        const child = spawn(file ?? 'ssh', fileArgs, {
          env: { PATH: process.env['PATH'], ...options.env },
          stdio: [options.terminal ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
        const closed = Promise.withResolvers<number | null>();
        child.once('close', closed.resolve);
        child.stdin?.end(options.input);
        const code = await closed.promise;
        return {
          code,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        };
      },
      handled,
      async [Symbol.asyncDispose]() {
        const closed = once(server, 'close');
        server.close();
        await closed;
        try {
          await handled();
        } finally {
          await directory[Symbol.asyncDispose]();
        }
      },
    };
  } catch (error) {
    await directory[Symbol.asyncDispose]();
    throw error;
  }
}

/** BSD script takes the command as argv; util-linux script takes one shell string and needs -e for its exit status. */
function underScript(argv: readonly string[]): readonly string[] {
  if (process.platform === 'darwin') {
    return ['script', '-q', '/dev/null', ...argv];
  }
  const quoted = argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`);
  return ['script', '-q', '-e', '-c', quoted.join(' '), '/dev/null'];
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server listens on no TCP port.');
  }
  return address.port;
}
