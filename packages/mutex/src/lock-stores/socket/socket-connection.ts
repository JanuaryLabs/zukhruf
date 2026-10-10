import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { createInterface } from 'node:readline';

import type { Connection, ConnectionEvents } from '../remote/connection.ts';
import { jsonLine } from './json-line.ts';

/**
 * Newline-delimited JSON over a stream socket. A stream has no message
 * boundaries (writes arrive merged and split), so each message is one line
 * (see `jsonLine`). `isIncoming` checks each message from the peer; a line
 * that is not one closes the connection.
 */
export class SocketConnection<Outgoing, Incoming>
  extends EventEmitter<ConnectionEvents<Incoming>>
  implements Connection<Outgoing, Incoming>
{
  readonly #socket: Socket;

  constructor(
    socket: Socket,
    isIncoming: (message: unknown) => message is Incoming,
  ) {
    super();
    this.#socket = socket;
    // Every error is followed by `close`, which is where the peer's loss is handled.
    socket.on('error', () => {});
    createInterface({ input: socket, crlfDelay: Infinity })
      .on('line', (line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          if (isIncoming(parsed)) this.emit('message', parsed);
          else this.close();
        } catch {
          this.close();
        }
      })
      // readline re-emits socket errors (e.g. EPIPE when the peer died); `close` reports the loss.
      .on('error', () => {});
    socket.once('close', () => this.emit('close'));
  }

  send(message: Outgoing): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.#socket.writable) {
        reject(new Error('The socket is closed.'));
        return;
      }
      this.#socket.write(jsonLine(message), (error) =>
        error ? reject(error) : resolve(),
      );
    });
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
