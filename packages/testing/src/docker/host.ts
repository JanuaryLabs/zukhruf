import { once } from 'node:events';
import { mkdtempDisposable, stat } from 'node:fs/promises';
import { type Socket, connect, createServer } from 'node:net';
import { join } from 'node:path';

import command, {
  type Result,
  type Subprocess,
  SubprocessError,
} from 'nano-spawn';

import { timebox } from '../async/timebox.ts';
import { type ProcessRun, forwardPrefix } from './run-records.ts';

export const quote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

/** How long one command in the SSH engine's remote shell may take. */
export const SHELL_TIMEOUT = 30_000;

/** Local Unix sockets, Docker Desktop's named pipe on Windows, and SSH engines. A `tcp://` engine may be on another machine. */
const supportedEndpoints = ['unix://', 'npipe://', 'ssh://'];

/**
 * A command this process started. A killed process leaves its commands
 * running; their process records keep its run until they end.
 */
async function recorded(
  run: ProcessRun | undefined,
  subprocess: Subprocess,
): Promise<Result> {
  if (!run) return subprocess;
  // Awaited below; a command that fails while its record is written must
  // not count as an unhandled rejection.
  subprocess.catch(() => {});
  const { pid } = await subprocess.nodeChildProcess;
  // Node leaves pid undefined when the spawn failed: no process to record.
  if (pid === undefined) return subprocess;
  await using _record = await run.records.recordProcess(pid);
  return await subprocess;
}

/**
 * The endpoint of an engine, for what the Engine API does not do: a shell
 * on the host of an SSH engine and port forwards from it. With a run, each
 * command it starts has a process record while it runs.
 */
export class DockerHost {
  readonly endpoint: string;
  readonly #run: ProcessRun | undefined;

  constructor(endpoint: string, run: ProcessRun | undefined) {
    if (!supportedEndpoints.some((scheme) => endpoint.startsWith(scheme))) {
      throw new Error(
        `Unsupported Docker endpoint ${endpoint}; tests support ${supportedEndpoints.join(', ')}`,
      );
    }
    this.endpoint = endpoint;
    this.#run = run;
  }

  get remote(): boolean {
    return this.endpoint.startsWith('ssh://');
  }

  sshArgs(options: string[] = []): string[] {
    const url = new URL(this.endpoint);
    // Pass the original hostname to OpenSSH: ~/.ssh/config, jump hosts, keys,
    // agents and host-key policy continue to work exactly as for Docker.
    return [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=10',
      '-o',
      'ServerAliveCountMax=2',
      ...(url.port ? ['-p', url.port] : []),
      ...(url.username ? ['-l', decodeURIComponent(url.username)] : []),
      ...options,
      url.hostname,
    ];
  }

  shell(script: string, input?: string): Promise<Result> {
    return recorded(
      this.#run,
      command('ssh', [...this.sshArgs(), script], {
        stdin: input === undefined ? 'ignore' : { string: input },
        timeout: SHELL_TIMEOUT,
      }),
    );
  }

  async forward(
    port: number,
  ): Promise<{ port: number; close: () => Promise<void> }> {
    const run = this.#run;
    if (!this.remote) return { port, close: async () => {} };
    const resources = new AsyncDisposableStack();
    const close = () => resources.disposeAsync();
    try {
      // Keep the Unix socket path below macOS's 104-byte limit. The private
      // directory and ownership record also cover workers killed mid-test.
      const directory = resources.use(
        await mkdtempDisposable(forwardPrefix(run?.id)),
      );
      if (run)
        resources.use(await run.records.record('forward', directory.path));
      const path = join(directory.path, 's');
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        const channel = connect(path);
        const pairs: [Socket, Socket][] = [
          [socket, channel],
          [channel, socket],
        ];
        for (const [stream, peer] of pairs) {
          sockets.add(stream);
          stream.on('error', () => peer.destroy());
          stream.once('close', () => {
            sockets.delete(stream);
            peer.destroy();
          });
        }
        socket.pipe(channel).pipe(socket);
      });
      // OpenSSH multiplexes client streams over one authenticated connection.
      // Node owns the ephemeral TCP listener, so no port-reservation race or
      // fresh SSH login is added to each database client's connect timeout.
      // A remote `cat` on a stdin pipe this process holds, not -N: when this
      // process dies, even by SIGKILL, the OS closes the pipe, `cat` reads
      // EOF and ssh exits instead of staying connected under PID 1. The
      // command needs a remote shell, which the Docker CLI over ssh already
      // uses to run `docker system dial-stdio`.
      const ssh = command(
        'ssh',
        [
          ...this.sshArgs([
            '-S',
            'none',
            '-o',
            'ControlMaster=no',
            '-o',
            'ControlPersist=no',
            '-o',
            'ExitOnForwardFailure=yes',
            '-L',
            `${path}:127.0.0.1:${port}`,
          ]),
          'cat >/dev/null',
        ],
        { stdin: 'pipe', stdout: 'ignore' },
      );
      // How ssh ended, with what it printed: a Result for exit 0, or the
      // SubprocessError for a failure or a signal.
      const exit = ssh.then(
        (result): Result => result,
        (error: unknown) => {
          if (error instanceof SubprocessError) return error;
          throw error;
        },
      );
      void exit.then(() => {
        for (const socket of sockets) socket.destroy();
        if (server.listening) server.close();
      });
      const child = await ssh.nodeChildProcess;
      // Disposed after ssh has stopped.
      if (run && child.pid !== undefined)
        resources.use(await run.records.recordProcess(child.pid));
      resources.defer(async () => {
        child.stdin!.end();
        const deadline = setTimeout(() => child.kill('SIGKILL'), 1_000);
        try {
          await exit;
        } finally {
          clearTimeout(deadline);
        }
      });
      resources.defer(async () => {
        const closed = new Promise<void>((resolve, reject) =>
          server.close((error) =>
            error &&
            !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')
              ? reject(error)
              : resolve(),
          ),
        );
        for (const socket of sockets) socket.destroy();
        await closed;
      });
      // OpenSSH binds local forwards after authentication. Wait for that
      // listener before publishing the TCP port to a database client.
      const waiting = new AbortController();
      try {
        await Promise.race([
          timebox(
            async () => {
              if (!(await stat(path)).isSocket())
                throw new Error(
                  'Docker SSH forwarding did not create a Unix socket',
                );
            },
            {
              maxRetryTime: 15_000,
              signal: waiting.signal,
              shouldRetry: ({ error }) =>
                'code' in error && error.code === 'ENOENT',
            },
          ),
          exit.then((outcome) => {
            throw new Error(
              `Docker SSH forwarding exited: ${outcome.stderr.trim()}`,
              { cause: outcome },
            );
          }),
        ]);
      } finally {
        waiting.abort();
      }
      // Runs first on close, before ssh is stopped: an ssh that already
      // exited ended the forward while it was in use.
      resources.defer(async () => {
        if (child.exitCode === null && child.signalCode === null) return;
        const outcome = await exit;
        throw new Error(
          `Docker SSH forwarding was lost: ${outcome.stderr.trim()}`,
          { cause: outcome },
        );
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      server.unref();
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Docker forwarding did not acquire a TCP port');
      return { port: address.port, close };
    } catch (error) {
      await close();
      throw error;
    }
  }
}
