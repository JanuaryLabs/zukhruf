import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

import { isErrno } from '@zukhruf/fs';
import {
  type Connection,
  ConnectionClosedError,
  type ConnectionEvents,
} from '@zukhruf/rpc';

import { jsonLine } from './json-line.ts';
import { leaveErrorsToClose } from './leave-errors-to-close.ts';

/**
 * Newline-delimited JSON over a stream socket. A stream has no message
 * boundaries (writes arrive merged and split), so each message is one line
 * (see `jsonLine`). A line that is not JSON breaks the framing, so it closes
 * the connection; any JSON value goes to the listener, which checks it.
 */
export class SocketConnection<Outgoing>
  extends EventEmitter<ConnectionEvents>
  implements Connection<Outgoing>
{
  readonly #socket: Socket;
  /** A write after the socket closed reports the error through its callback. */
  readonly #write: (line: string) => Promise<void>;

  constructor(socket: Socket) {
    super();
    this.#socket = socket;
    this.#write = promisify<string, void>(socket.write).bind(socket);
    // readline removes its own 'error' listener from the socket when the
    // interface closes on the peer's FIN, so an error after that (e.g. a reset
    // after the half-close) needs this listener of the socket's own.
    leaveErrorsToClose(socket);
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('line', (line) => {
      try {
        this.emit('message', JSON.parse(line));
      } catch {
        this.#socket.destroy();
      }
    });
    // readline re-emits the socket's errors (e.g. EPIPE when the peer died).
    leaveErrorsToClose(lines);
    socket.once('close', () => this.emit('close'));
  }

  async send(message: Outgoing): Promise<void> {
    try {
      await this.#write(jsonLine(message));
    } catch (error) {
      // The write that meets the closed peer fails with EPIPE, and each write after it with ERR_STREAM_DESTROYED.
      if (isErrno(error, 'EPIPE') || isErrno(error, 'ERR_STREAM_DESTROYED')) {
        throw new ConnectionClosedError({ cause: error });
      }
      throw error;
    }
  }

  ref() {
    this.#socket.ref();
  }

  unref() {
    this.#socket.unref();
  }

  async close() {
    this.#socket.destroy();
  }
}
