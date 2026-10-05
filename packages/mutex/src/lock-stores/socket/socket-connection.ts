import type { Socket } from 'node:net';
import { createInterface } from 'node:readline';

import type { Connection, ConnectionHandlers } from '../remote/connection.ts';

/**
 * Newline-delimited JSON over a stream socket. A stream has no message
 * boundaries (writes arrive merged and split), and JSON escapes newlines inside
 * strings, so one line is always one message.
 */
export class SocketConnection<Outgoing, Incoming> implements Connection<
  Outgoing,
  Incoming
> {
  readonly #socket: Socket;

  constructor(socket: Socket) {
    this.#socket = socket;
    // Every error is followed by `close`, which is where the peer's loss is handled.
    socket.on('error', () => {});
  }

  send(message: Outgoing): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.#socket.writable) {
        reject(new Error('The socket is closed.'));
        return;
      }
      this.#socket.write(`${JSON.stringify(message)}\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  listen({ message, close }: ConnectionHandlers<Incoming>) {
    createInterface({ input: this.#socket, crlfDelay: Infinity })
      .on('line', (line) => {
        try {
          message(JSON.parse(line) as Incoming);
        } catch {
          this.close();
        }
      })
      // readline re-emits socket errors (e.g. EPIPE when the peer died); `close` reports the loss.
      .on('error', () => {});
    this.#socket.once('close', close);
  }

  ref() {
    this.#socket.ref();
  }

  unref() {
    this.#socket.unref();
  }

  close() {
    this.#socket.destroy();
  }
}
