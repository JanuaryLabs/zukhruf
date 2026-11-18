import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';

import { FrameType, encode } from './wire.ts';

type Callback = (error?: Error | null) => void;

/** What the owner of the Unix connection does for the stream. */
export interface StreamOwner {
  /** A write after the close of the Unix connection. */
  writeAfterClose(callback: Callback): void;
  /** The stream was destroyed. */
  destroyed(): void;
}

/**
 * The data of a channel over its Unix connection: a write goes out as a data
 * frame and the end as an eof frame. The owner reads the frames of the master
 * and gives the data and the eof to the stream.
 */
export class ControlStream extends Duplex {
  readonly #socket: Socket;
  readonly #owner: StreamOwner;

  constructor(socket: Socket, owner: StreamOwner) {
    super({ allowHalfOpen: true });
    this.#socket = socket;
    this.#owner = owner;
  }

  receive(chunk: Buffer): void {
    if (!this.push(chunk)) this.#socket.pause();
  }

  receiveEof(): void {
    this.push(null);
  }

  /** The Unix connection closed, after the eof: with `error` the stream fails with it; with none it closes after its end. */
  connectionClosed(error: Error | undefined): void {
    if (error !== undefined) this.destroy(error);
    else if (this.readableEnded) this.destroy();
    else this.once('end', () => this.destroy());
  }

  override _read(): void {
    this.#socket.resume();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: Callback,
  ): void {
    if (this.#isClosed()) this.#owner.writeAfterClose(callback);
    else this.#socket.write(encode(FrameType.data, chunk), callback);
  }

  override _final(callback: Callback): void {
    if (!this.#isClosed()) this.#socket.write(encode(FrameType.eof));
    callback();
  }

  override _destroy(error: Error | null, callback: Callback): void {
    this.#owner.destroyed();
    callback(error);
  }

  #isClosed(): boolean {
    return this.#socket.destroyed || this.#socket.writableEnded;
  }
}
