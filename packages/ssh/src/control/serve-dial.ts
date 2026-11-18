import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import { toWire } from './messages.ts';
import { FrameType, encode, encodeJson, readFrames } from './wire.ts';

/**
 * Carries a dialed channel over its Unix connection: data and eof frames both
 * ways. The close of one closes the other; a channel that failed, as on the
 * loss of the master's connection, sends its error as the last frame.
 */
export function serveDial(channel: Duplex, socket: Socket): void {
  readFrames(socket, (frame) => {
    switch (frame.type) {
      case FrameType.data:
        if (!channel.write(frame.payload)) {
          socket.pause();
          channel.once('drain', () => socket.resume());
        }
        return;
      case FrameType.eof:
        channel.end();
        return;
      default:
        socket.destroy();
    }
  });
  relay(channel, socket, FrameType.data);
  channel.once('end', () => socket.write(encode(FrameType.eof)));
  let failure: Error | undefined;
  channel.once('error', (error: Error) => {
    failure = error;
  });
  channel.once('close', () => {
    if (failure !== undefined) {
      socket.write(encodeJson(FrameType.error, toWire(failure)));
    }
    socket.end();
  });
  socket.once('close', () => channel.destroy());
}

/** Sends each chunk of `source` as a frame of `type`, and pauses it while the socket is full. */
export function relay(
  source: NodeJS.ReadableStream,
  socket: Socket,
  type: number,
): void {
  source.on('data', (chunk: Buffer) => {
    if (socket.write(encode(type, chunk))) return;
    source.pause();
    socket.once('drain', () => source.resume());
  });
}
