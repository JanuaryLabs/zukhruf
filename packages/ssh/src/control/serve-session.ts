import type { Socket } from 'node:net';
import { finished } from 'node:stream/promises';

import {
  ExitError,
  ExitMissingError,
  type Session,
  isSignalName,
} from '../session.ts';
import { type Ending, isWindowSize, toWire } from './messages.ts';
import { relay } from './serve-dial.ts';
import {
  type Frame,
  FrameType,
  decodeJson,
  encode,
  encodeJson,
  readFrames,
} from './wire.ts';

/**
 * Carries a started session over its Unix connection: stdin, its end,
 * window-change, signal and close from the client; stdout, stderr, their end
 * and the exit to it. The exit frame goes after the last output, then the
 * master closes the connection. The close of the connection closes the
 * channel, and so does a frame that the protocol does not have.
 */
export function serveSession(session: Session, socket: Socket): void {
  readFrames(socket, (frame) => {
    if (!apply(session, socket, frame)) socket.destroy();
  });
  relay(session.stdout, socket, FrameType.data);
  relay(session.stderr, socket, FrameType.extendedData);
  const outputEnded = Promise.allSettled([
    finished(session.stdout),
    finished(session.stderr),
  ]).then(() => socket.write(encode(FrameType.eof)));
  socket.once('close', () => void session.close());
  void session
    .wait()
    .then(
      (): Ending => ({ kind: 'exit', exit: { kind: 'status', exitStatus: 0 } }),
      endingOf,
    )
    .then(async (ending) => {
      await outputEnded;
      socket.end(encodeJson(FrameType.exit, ending));
    });
}

/** False for a frame that the protocol does not have. */
function apply(session: Session, socket: Socket, frame: Frame): boolean {
  switch (frame.type) {
    case FrameType.data:
      if (!session.stdin.write(frame.payload)) {
        socket.pause();
        session.stdin.once('drain', () => socket.resume());
      }
      return true;
    case FrameType.eof:
      session.stdin.end();
      return true;
    case FrameType.windowChange: {
      const size = decodeJson(frame);
      if (!isWindowSize(size)) return false;
      void session.windowChange(size);
      return true;
    }
    case FrameType.signal: {
      const name = frame.payload.toString();
      if (!isSignalName(name)) return false;
      void session.signal(name);
      return true;
    }
    case FrameType.close:
      void session.close();
      return true;
    default:
      return false;
  }
}

function endingOf(error: unknown): Ending {
  if (error instanceof ExitError) return { kind: 'exit', exit: error.exit };
  const cause = error instanceof ExitMissingError ? error.cause : error;
  return cause === undefined
    ? { kind: 'missing' }
    : { kind: 'missing', cause: toWire(cause) };
}
