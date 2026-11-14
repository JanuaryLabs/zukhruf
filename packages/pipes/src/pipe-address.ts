import { once } from 'node:events';
import { type Socket, connect } from 'node:net';

/** Where to connect: the path of a pipe on this system, as a program published it. Go's net.UnixAddr. */
export class PipeAddress {
  /** The path that `node:net` connects to: a socket path on macOS and Linux, a pipe path on Windows. */
  readonly path: string;

  /** Checks nothing and makes nothing: the program that made the path checked it. */
  constructor(path: string) {
    this.path = path;
  }

  /** Tries once (ADR 0006). Resolves when the socket is connected. */
  async connect(options: { signal?: AbortSignal } = {}): Promise<Socket> {
    const socket = connect({ path: this.path, ...options });
    try {
      await once(socket, 'connect');
      return socket;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }
}
