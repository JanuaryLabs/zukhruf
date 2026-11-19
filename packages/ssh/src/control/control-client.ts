import { once } from 'node:events';
import { type Socket, connect } from 'node:net';
import { type Duplex, Readable } from 'node:stream';

import { OpenChannelError } from '../client.ts';
import {
  type Session,
  type SessionChannel,
  type SessionStart,
  createSession,
} from '../session.ts';
import { ControlStream } from './control-stream.ts';
import {
  type Ending,
  type Request,
  fromWire,
  isEnding,
  isReply,
  isWireError,
} from './messages.ts';
import {
  FrameType,
  decodeJson,
  encode,
  encodeJson,
  readFirstFrame,
  readFrames,
  readHello,
} from './wire.ts';

/** Opens channels through the master at `path`, one connection to the socket for each channel. */
export class ControlClient {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  /** As Client#dial. */
  async dial(network: 'tcp' | 'unix', address: string): Promise<Duplex> {
    const socket = await openChannel(this.#path, {
      kind: 'dial',
      network,
      address,
    });
    return dialStream(socket);
  }

  /** As Client#newSession. */
  newSession(): Session {
    return createSession(async (start: SessionStart) =>
      sessionChannel(await openChannel(this.#path, { kind: 'session', start })),
    );
  }
}

function masterClosed(): Error {
  return new Error('ssh: the control master closed the connection');
}

function protocolError(): Error {
  return new Error('ssh: the control master broke the protocol');
}

/** Connects and sends the request, and resolves with the socket when the master opened the channel. */
async function openChannel(path: string, request: Request): Promise<Socket> {
  return sendRequest(await greet(path), request);
}

/** The peer at the socket closed, or spoke another protocol, before a hello: no request reached a master. */
export class NoHelloError extends Error {
  override name = 'NoHelloError';
}

/**
 * Connects to the master at `path` and reads its hello. It rejects with the
 * error of the connect (ENOENT when nothing is at the path, ECONNREFUSED when
 * nothing listens there), or with NoHelloError. The signal closes the
 * socket, and the wait for the hello then rejects with NoHelloError.
 */
export async function greet(
  path: string,
  signal?: AbortSignal,
): Promise<Socket> {
  const socket = connect(signal === undefined ? { path } : { path, signal });
  await once(socket, 'connect');
  // An error of the socket is followed by its close, which ends the channel.
  socket.on('error', () => socket.destroy());
  try {
    await readHello(
      socket,
      new NoHelloError(
        'ssh: the peer at the control socket sent no hello: it closed first, or it speaks another protocol',
      ),
    );
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** Sends the request on a socket that greet() gave, and resolves with the socket when the master opened the channel. */
export async function sendRequest(
  socket: Socket,
  request: Request,
): Promise<Socket> {
  socket.write(encodeJson(FrameType.request, request));
  try {
    const frame = await readFirstFrame(socket, masterClosed());
    const reply = decodeJson(frame);
    if (frame.type !== FrameType.reply || !isReply(reply)) {
      throw protocolError();
    }
    if (!reply.opened) {
      throw 'refused' in reply
        ? new OpenChannelError(reply.refused.code, reply.refused.description)
        : fromWire(reply.error);
    }
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

// The master sends an error frame when the channel failed. A close with no
// eof and no error is the death of the master.
export function dialStream(socket: Socket): Duplex {
  const stream = new ControlStream(socket, {
    destroyed: () => socket.destroy(),
  });
  let eof = false;
  let failure: Error | undefined;
  readFrames(socket, (frame) => {
    if (frame.type === FrameType.data) {
      stream.receive(frame.payload);
      return;
    }
    if (frame.type === FrameType.eof) {
      eof = true;
      stream.receiveEof();
      return;
    }
    const error = decodeJson(frame);
    failure =
      frame.type === FrameType.error && isWireError(error)
        ? fromWire(error)
        : protocolError();
    socket.destroy();
  });
  socket.once('close', () => {
    stream.connectionClosed(failure ?? (eof ? undefined : masterClosed()));
  });
  return stream;
}

// The session's streams end at the eof frame, or at the close of the
// connection; the exit frame, or its absence, goes to onClose.
export function sessionChannel(socket: Socket): SessionChannel {
  const stream = new ControlStream(socket, {
    destroyed: () => undefined,
  });
  const stderr = new Readable({ read: () => socket.resume() });
  let eof = false;
  let ending: Ending | undefined;
  const receiveEof = (): void => {
    eof = true;
    stream.receiveEof();
    stderr.push(null);
  };
  readFrames(socket, (frame) => {
    switch (frame.type) {
      case FrameType.data:
        stream.receive(frame.payload);
        return;
      case FrameType.extendedData:
        if (!stderr.push(frame.payload)) socket.pause();
        return;
      case FrameType.eof:
        receiveEof();
        return;
      case FrameType.exit: {
        const value = decodeJson(frame);
        if (isEnding(value)) {
          ending = value;
          return;
        }
      }
    }
    socket.destroy();
  });
  const closed = new Promise<Ending | undefined>((resolve) => {
    socket.once('close', () => {
      if (!eof) receiveEof();
      stream.connectionClosed(undefined);
      resolve(ending);
    });
  });
  const send = (frame: Buffer): void => {
    if (!socket.destroyed && !socket.writableEnded) socket.write(frame);
  };
  return {
    stream,
    stderr,
    onClose: (listener) => {
      void closed.then((end) => {
        if (end === undefined) listener(undefined, masterClosed());
        else if (end.kind === 'exit') listener(end.exit, undefined);
        else listener(undefined, end.cause && fromWire(end.cause));
      });
    },
    windowChange: (size) => send(encodeJson(FrameType.windowChange, size)),
    signal: (name) => send(encode(FrameType.signal, name)),
    close: () => send(encode(FrameType.close)),
  };
}
