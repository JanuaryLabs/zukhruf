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
      /**
       * Closes the socket and exits with 0 after the first answer, as `docker system dial-stdio` does when the engine restarts.
       * With 'pipes-open-until-next-write', a child of the stand-in keeps its
       * standard input and output open after the exit, until the next write
       * to them or the end of the input: the exit of `ssh` then comes long
       * before the close of its pipes.
       */
      exitAfterFirstAnswer?: boolean | 'pipes-open-until-next-write';
      /**
       * Writes NOT_RESPONDING and exits with 255 after a chunk with this text
       * passed through it, in either direction, as `ssh` does when its
       * keepalive (`ServerAliveInterval`) gets no answer from the machine.
       */
      notRespondingAfter?: string;
    }
  /** Exits with 255 and the message of OpenSSH for a key that the machine refuses. */
  | { kind: 'permission-denied' };

/** The message of OpenSSH when the machine refuses each key, as the permission-denied mode writes it. */
export const PERMISSION_DENIED =
  'tester@machine: Permission denied (publickey).';

/** The message of OpenSSH when its keepalive gets no answer, as notRespondingAfter writes it. */
export const NOT_RESPONDING = 'Timeout, server machine not responding.';

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
 * the socket closes, it exits. With ignoreInputEnd, it does neither. With
 * exitAfterFirstAnswer, it closes the socket after the first answer; with
 * 'pipes-open-until-next-write', a child that it starts then keeps its
 * pipes open until the next write to them or the end of the input. With
 * notRespondingAfter, it passes the chunk that has the text, and then it
 * writes NOT_RESPONDING and exits with 255.
 */
const script = `#!${process.execPath}
const { spawn } = require('node:child_process');
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
if (mode.exitAfterFirstAnswer) {
  socket.once('data', () => setImmediate(() => {
    if (mode.exitAfterFirstAnswer === 'pipes-open-until-next-write') {
      const holder = spawn(
        process.execPath,
        ['-e', "process.stdin.once('data', () => process.exit(0)).once('end', () => process.exit(0));"],
        { stdio: ['inherit', 'inherit', 'ignore'] },
      );
      holder.unref();
    }
    socket.destroy();
  }));
}
if (mode.notRespondingAfter) {
  // The empty write ends after the chunk that the pipe wrote before it.
  const stopAfter = (passed) => (chunk) => {
    if (!chunk.includes(mode.notRespondingAfter)) return;
    passed.write('', () => {
      process.stderr.write(${JSON.stringify(`${NOT_RESPONDING}\r\n`)}, () => process.exit(255));
    });
  };
  process.stdin.on('data', stopAfter(socket));
  socket.on('data', stopAfter(process.stdout));
}
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
