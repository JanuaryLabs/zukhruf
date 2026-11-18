import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';

const run = promisify(execFile);

export interface SshAgent extends AsyncDisposable {
  /** The socket where the agent listens. */
  readonly socket: string;
  /** The temporary directory that holds the socket and the keys. */
  readonly directory: string;
  /** Generates a key with `ssh-keygen` in the directory, with `name` as its comment, and returns the path of its private key file. */
  generateKey(
    name: string,
    type?: 'ed25519' | 'rsa' | 'ecdsa',
  ): Promise<string>;
  /** Runs OpenSSH's `ssh-add` against the agent with `args`. */
  sshAdd(args: readonly string[]): Promise<void>;
  /** The lines of `ssh-add -l` (`<bits> SHA256:… <comment> (<TYPE>)`); empty when the agent has no identities. */
  listed(): Promise<string[]>;
  /** The fingerprint of a key file, as `ssh-keygen -l` prints it. */
  fingerprint(keyFile: string): Promise<string>;
}

/**
 * A real OpenSSH `ssh-agent -D -a <socket>` for one test. `environment` is
 * the environment of the agent, such as SSH_ASKPASS for a confirm constraint.
 */
export async function startSshAgent(
  options: { readonly environment?: Readonly<Record<string, string>> } = {},
): Promise<SshAgent> {
  const directory = await new TemporaryFiles().directory('ssh-agent-', {
    parent: '/tmp',
  });
  const socket = join(directory.path, 'agent.sock');
  const child = spawn('ssh-agent', ['-D', '-a', socket], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { PATH: process.env['PATH'] ?? '', ...options.environment },
  });
  // ssh-agent prints SSH_AUTH_SOCK once it listens on the socket.
  await once(child.stdout, 'data');
  const env = { ...process.env, SSH_AUTH_SOCK: socket };
  const fingerprint = async (keyFile: string): Promise<string> => {
    const { stdout } = await run('ssh-keygen', ['-l', '-f', keyFile]);
    return stdout.split(' ')[1] ?? '';
  };
  return {
    socket,
    directory: directory.path,
    async generateKey(name, type = 'ed25519') {
      const file = join(directory.path, name);
      await run('ssh-keygen', [
        '-q',
        '-t',
        type,
        '-N',
        '',
        '-C',
        name,
        '-f',
        file,
      ]);
      return file;
    },
    async sshAdd(args) {
      await run('ssh-add', args, { env });
    },
    async listed() {
      try {
        const { stdout } = await run('ssh-add', ['-l'], { env });
        return stdout.trim().split('\n');
      } catch (error) {
        if (Error.isError(error) && 'code' in error && error.code === 1) {
          return [];
        }
        throw error;
      }
    },
    fingerprint,
    async [Symbol.asyncDispose]() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
      await directory[Symbol.asyncDispose]();
    },
  };
}
