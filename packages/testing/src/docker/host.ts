import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempDisposable, stat } from 'node:fs/promises';
import { type Socket, connect, createServer } from 'node:net';
import { join } from 'node:path';

import command from 'nano-spawn';

import { timebox } from '../async/timebox.ts';
import { type TestRun, forwardPrefix } from './test-run.ts';

export const quote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

/** Local Unix sockets, Docker Desktop's named pipe on Windows, and SSH engines. A `tcp://` engine may be on another machine. */
const supportedEndpoints = ['unix://', 'npipe://', 'ssh://'];

/** Resolve with the Docker CLI so its native context/environment precedence wins. */
export class DockerHost {
  readonly endpoint: string;

  private constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  static async resolve(): Promise<DockerHost> {
    const { stdout } = await command('docker', [
      'context',
      'inspect',
      '--format',
      '{{.Endpoints.docker.Host}}',
    ]);
    const endpoint = stdout.trim();
    if (!supportedEndpoints.some((scheme) => endpoint.startsWith(scheme))) {
      throw new Error(
        `Unsupported Docker endpoint ${endpoint}; tests support ${supportedEndpoints.join(', ')}`,
      );
    }
    return new DockerHost(endpoint);
  }

  get remote(): boolean {
    return this.endpoint.startsWith('ssh://');
  }

  readonly command = (args: string[]) =>
    command('docker', args, {
      env: { DOCKER_CONTEXT: undefined, DOCKER_HOST: this.endpoint },
      timeout: 240_000,
    });

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

  shell(script: string, input?: string) {
    return command('ssh', [...this.sshArgs(), script], {
      stdin: input === undefined ? 'ignore' : { string: input },
      timeout: 30_000,
    });
  }

  async forward(
    port: number,
    run: TestRun | undefined,
  ): Promise<{ port: number; close: () => Promise<void> }> {
    if (!this.remote) return { port, close: async () => {} };
    const resources = new AsyncDisposableStack();
    const close = () => resources.disposeAsync();
    try {
      // Keep the Unix socket path below macOS's 104-byte limit. The private
      // directory and ownership record also cover workers killed mid-test.
      const directory = resources.use(
        await mkdtempDisposable(forwardPrefix(run)),
      );
      if (run) resources.use(await run.record('forward', directory.path));
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
      const child = spawn(
        'ssh',
        this.sshArgs([
          '-N',
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
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let errorOutput = '';
      let spawnError: Error | undefined;
      child.stderr.on('data', (data) => {
        errorOutput += data;
      });
      child.once('error', (error) => {
        spawnError = error;
      });
      const exited = new Promise<void>((resolve) =>
        child.once('close', (code) => {
          if (code && errorOutput)
            process.stderr.write(`Docker SSH forwarding: ${errorOutput}`);
          for (const socket of sockets) socket.destroy();
          if (server.listening) server.close();
          resolve();
        }),
      );
      resources.defer(async () => {
        child.kill('SIGTERM');
        const deadline = setTimeout(() => child.kill('SIGKILL'), 1_000);
        try {
          await exited;
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
      await timebox(
        async () => {
          if (spawnError) throw spawnError;
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(
              `Docker SSH forwarding exited: ${errorOutput.trim()}`,
            );
          if (!(await stat(path)).isSocket())
            throw new Error(
              'Docker SSH forwarding did not create a Unix socket',
            );
        },
        {
          maxRetryTime: 15_000,
          shouldRetry: ({ error }) =>
            !spawnError && 'code' in error && error.code === 'ENOENT',
        },
      );
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
