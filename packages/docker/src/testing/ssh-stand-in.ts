import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Docker } from '../index.ts';

/** What the stand-in does after it records its run. */
export type SshStandInMode =
  /** Pipes its standard input and output to the engine socket, as `docker system dial-stdio` does. */
  | {
      kind: 'engine';
      socketPath: string;
      /** Keeps the socket open and keeps running when its standard input ends, as a hung `ssh` does. */
      ignoreInputEnd?: boolean;
    }
  /** Exits with 255 and the message of OpenSSH for a key that the machine refuses. */
  | { kind: 'permission-denied' };

/** The message of OpenSSH when the machine refuses each key, as the permission-denied mode writes it. */
export const PERMISSION_DENIED =
  'tester@machine: Permission denied (publickey).';

/** One start of the stand-in. */
export interface SshRun {
  pid: number;
  /** The arguments after the program name. */
  argv: string[];
}

/**
 * Stands in for OpenSSH's `ssh ... docker system dial-stdio`. It records its
 * pid and arguments in runs/<pid>.json. In the engine mode it pipes its
 * standard input to the engine socket and the socket to its standard output.
 * When its standard input ends, it ends the write side of the socket. When
 * the socket closes, it exits. With ignoreInputEnd, it does neither.
 */
const script = `#!${process.execPath}
const { connect } = require('node:net');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
mkdirSync(join(__dirname, 'runs'), { recursive: true });
writeFileSync(
  join(__dirname, 'runs', process.pid + '.json'),
  JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }),
);
const mode = JSON.parse(readFileSync(join(__dirname, 'ssh-mode.json'), 'utf8'));
if (mode.kind === 'permission-denied') {
  process.stderr.write(${JSON.stringify(`${PERMISSION_DENIED}\r\n`)});
  process.exit(255);
}
const socket = connect(mode.socketPath);
socket.on('error', (error) => {
  process.stderr.write('stand-in: ' + error.message + '\\n');
  process.exitCode = 1;
});
process.stdin.pipe(socket, { end: !mode.ignoreInputEnd });
socket.pipe(process.stdout);
socket.on('close', () => process.stdin.destroy());
`;

/**
 * A directory with an executable `ssh` stand-in, for the start of PATH.
 * Disposal removes the directory.
 */
export async function sshStandIn(mode: SshStandInMode) {
  const path = await mkdtemp(join(tmpdir(), 'docker-ssh-'));
  await writeFile(join(path, 'ssh'), script, { mode: 0o755 });
  await writeFile(join(path, 'ssh-mode.json'), JSON.stringify(mode));
  return {
    path,
    /** Each start of the stand-in until now. */
    async runs(): Promise<SshRun[]> {
      const names = await readdir(join(path, 'runs')).catch(() => []);
      return Promise.all(
        names.map(async (name) => {
          const run: SshRun = JSON.parse(
            await readFile(join(path, 'runs', name), 'utf8'),
          );
          return run;
        }),
      );
    },
    [Symbol.asyncDispose]: () =>
      rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
  };
}

/**
 * The socket of the local engine: the host of the context that config.json
 * makes current, when it is a unix:// host. DOCKER_CONTEXT does not apply, so
 * a run on an SSH engine still finds the engine of this machine.
 */
export async function localEngineSocket(): Promise<string | undefined> {
  const current = (await Docker.contexts()).find((context) => context.current);
  return current?.host.startsWith('unix://')
    ? current.host.slice('unix://'.length)
    : undefined;
}

/** True when the process with this pid runs. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
