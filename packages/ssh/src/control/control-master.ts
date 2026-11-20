import { once } from 'node:events';
import { type Server, type Socket, createServer } from 'node:net';

import { type Client, OpenChannelError, rejectionCode } from '../client.ts';
import { type Reply, type Request, isRequest, toWire } from './messages.ts';
import { serveDial } from './serve-dial.ts';
import { serveSession } from './serve-session.ts';
import {
  type Frame,
  FrameType,
  decodeJson,
  encode,
  encodeJson,
  readFirstFrame,
} from './wire.ts';

/** Serves the channels of a client to other processes on a Unix socket. OpenSSH's ControlMaster and ControlPath. */
export class ControlMaster implements AsyncDisposable {
  readonly path: string;
  readonly #server: Server;
  readonly #connections: Set<Socket>;

  private constructor(path: string, server: Server, connections: Set<Socket>) {
    this.path = path;
    this.#server = server;
    this.#connections = connections;
  }

  /** Listens on `path`. Disposal stops the listener and closes each channel that the master serves; it does not close `client`. */
  static async listen(client: Client, path: string): Promise<ControlMaster> {
    const connections = new Set<Socket>();
    const server = createServer((socket) => {
      connections.add(socket);
      socket.once('close', () => connections.delete(socket));
      serveConnection(client, socket);
    });
    server.listen(path);
    await once(server, 'listening');
    return new ControlMaster(path, server, connections);
  }

  /** The listener no longer keeps the Node process alive; the master still serves. Node's Server#unref. */
  unref(): void {
    this.#server.unref();
  }

  /** Undoes unref(): the listener keeps the Node process alive again. Node's Server#ref. */
  ref(): void {
    this.#server.ref();
  }

  /** node:net removes the socket file when the server closes. */
  async [Symbol.asyncDispose](): Promise<void> {
    const closed = once(this.#server, 'close');
    this.#server.close();
    for (const socket of this.#connections) socket.destroy();
    await closed;
  }
}

/** Serves one connection of a control client: the hello, then the channel or the hold of its request. A client that died leaves a write to fail; its close ends the channel. */
export function serveConnection(client: Client, socket: Socket): void {
  socket.on('error', () => socket.destroy());
  socket.write(encode(FrameType.hello));
  const closed = new Error('ssh: the control client closed the connection');
  void readFirstFrame(socket, closed).then(
    (frame) => open(client, socket, frame),
    (error: unknown) => {
      // A client that closes before its request needs no answer.
      if (error !== closed) throw error;
    },
  );
}

async function open(
  client: Client,
  socket: Socket,
  frame: Frame,
): Promise<void> {
  const request = requestOf(frame);
  if (request === undefined) {
    refuse(socket, new Error('ssh: the control client sent no valid request'));
    return;
  }
  if (request.kind === 'hold') {
    reply(socket, { opened: true });
    // readFirstFrame paused the socket: it reads again to see the close that
    // ends the hold.
    socket.resume();
    return;
  }
  try {
    if (request.kind === 'dial') {
      const channel = await client.dial(request.network, request.address);
      if (closedBefore(socket, () => channel.destroy())) return;
      reply(socket, { opened: true });
      serveDial(channel, socket);
    } else {
      const session = client.newSession();
      const { command, env, pty } = request.start;
      for (const [name, value] of Object.entries(env)) {
        session.setenv(name, value);
      }
      if (pty !== undefined) session.requestPty(pty.term, pty.size, pty.modes);
      await (command === undefined ? session.shell() : session.start(command));
      if (closedBefore(socket, () => void session.close())) return;
      reply(socket, { opened: true });
      serveSession(session, socket);
    }
  } catch (error) {
    refuse(socket, error);
  }
}

function requestOf(frame: Frame): Request | undefined {
  if (frame.type !== FrameType.request) return undefined;
  const value = decodeJson(frame);
  return isRequest(value) ? value : undefined;
}

/** The client went away while the channel opened. */
function closedBefore(socket: Socket, close: () => void): boolean {
  if (!socket.destroyed) return false;
  close();
  return true;
}

function reply(socket: Socket, answer: Reply): void {
  socket.write(encodeJson(FrameType.reply, answer));
}

// readFirstFrame paused the socket: it reads again to see the client's end,
// and closes.
function refuse(socket: Socket, error: unknown): void {
  const answer: Reply =
    error instanceof OpenChannelError
      ? {
          opened: false,
          refused: {
            code: rejectionCode(error.reason),
            description: error.description,
          },
        }
      : { opened: false, error: toWire(error) };
  socket.end(encodeJson(FrameType.reply, answer));
  socket.resume();
}
