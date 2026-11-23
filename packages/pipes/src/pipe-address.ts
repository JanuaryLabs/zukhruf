import { once } from 'node:events';
import { type Socket, connect } from 'node:net';

import { NoServerError } from './no-server-error.ts';

/**
 * The codes of a connect that no server listens for: nothing at the path, a
 * dead server's file, a file that is not a socket (macOS), and a server that
 * closed after the kernel queued the connection and before it accepted it
 * (Linux sets ECONNRESET on the client, af_unix.c unix_release_sock).
 */
const NO_SERVER = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK', 'ECONNRESET']);

/** Where to connect: the path of a pipe on this system, as a program published it. Go's net.UnixAddr. */
export class PipeAddress {
  /** The path that `node:net` connects to: a socket path on macOS and Linux, a pipe path on Windows. */
  readonly path: string;

  /** Checks nothing and makes nothing: the program that made the path checked it. */
  constructor(path: string) {
    this.path = path;
  }

  /**
   * Tries once (ADR 0006). Resolves when the socket is connected. Rejects
   * with `NoServerError` when no server listens on the path (ADR 0008), and
   * with the error of Node.js otherwise.
   */
  async connect(options: { signal?: AbortSignal } = {}): Promise<Socket> {
    const socket = connect({ path: this.path, ...options });
    try {
      await once(socket, 'connect');
      return socket;
    } catch (error) {
      socket.destroy();
      if (NO_SERVER.has(String(Reflect.get(Object(error), 'code'))))
        throw new NoServerError(this.path, { cause: error });
      throw error;
    }
  }
}
