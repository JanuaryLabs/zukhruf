import type { Socket } from 'node:net';

// Each frame is one byte of type, four bytes of length (big-endian) and the
// payload. The types after the request and the reply are the messages of an
// SSH channel (RFC 4254 §5.2, §5.3, §6.7, §6.9, §6.10), so each side relays
// one message for one message.
export const FrameType = {
  /** client → master, the first frame: JSON Request. */
  request: 0,
  /** master → client, the answer to the request: JSON Reply. */
  reply: 1,
  /** Both ways: SSH_MSG_CHANNEL_DATA; for a session, stdin or stdout. */
  data: 2,
  /** master → client: SSH_MSG_CHANNEL_EXTENDED_DATA type 1, stderr. */
  extendedData: 3,
  /** Both ways: SSH_MSG_CHANNEL_EOF. Empty. */
  eof: 4,
  /** client → master: SSH_MSG_CHANNEL_CLOSE of a session. Empty. */
  close: 5,
  /** client → master: window-change, JSON WindowSize. */
  windowChange: 6,
  /** client → master: signal, its name in UTF-8. */
  signal: 7,
  /** master → client, the last frame of a session: JSON Ending. */
  exit: 8,
  /** master → client, the last frame of a dial that failed: JSON WireError. */
  error: 9,
  /** master → client, the first frame of each connection, before the client sends its request: a client that gets no hello knows that no request reached the master, as OpenSSH's MUX_MSG_HELLO (PROTOCOL.mux). Empty. */
  hello: 10,
} as const;

export interface Frame {
  readonly type: number;
  readonly payload: Buffer;
}

const headerLength = 5;

export function encode(
  type: number,
  payload: Buffer | string = Buffer.alloc(0),
): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const header = Buffer.alloc(headerLength);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

export function encodeJson(type: number, value: unknown): Buffer {
  return encode(type, JSON.stringify(value));
}

/** The JSON of the payload; undefined when it is not JSON, which no check of messages.ts accepts. */
export function decodeJson(frame: Frame): unknown {
  try {
    return JSON.parse(frame.payload.toString());
  } catch {
    return undefined;
  }
}

/** The first frame of `buffered` and the bytes after it, or undefined while the frame is not whole. */
function takeFrame(
  buffered: Buffer,
): { readonly frame: Frame; readonly rest: Buffer } | undefined {
  if (buffered.length < headerLength) return undefined;
  const end = headerLength + buffered.readUInt32BE(1);
  if (buffered.length < end) return undefined;
  return {
    frame: {
      type: buffered.readUInt8(0),
      payload: buffered.subarray(headerLength, end),
    },
    rest: buffered.subarray(end),
  };
}

/**
 * The first frame of a connection: the request, or the reply. The socket is
 * paused after it, with the bytes after the frame put back, so the channel
 * reads them when it opens. Rejects with `closed` when the socket closes
 * first.
 */
export function readFirstFrame(socket: Socket, closed: Error): Promise<Frame> {
  // A paused socket stays paused for a new data listener: the frame before
  // this one, such as the hello, left it paused.
  socket.resume();
  const first = Promise.withResolvers<Frame>();
  let buffered: Buffer = Buffer.alloc(0);
  const onClose = (): void => first.reject(closed);
  const onData = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk]);
    const taken = takeFrame(buffered);
    if (taken === undefined) return;
    socket.off('data', onData);
    socket.off('close', onClose);
    socket.pause();
    if (taken.rest.length > 0) socket.unshift(taken.rest);
    first.resolve(taken.frame);
  };
  socket.on('data', onData);
  socket.once('close', onClose);
  return first.promise;
}

/** Gives each frame of the socket to `handler`, from the bytes that readFirstFrame left on. */
export function readFrames(
  socket: Socket,
  handler: (frame: Frame) => void,
): void {
  let buffered: Buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (
      let taken = takeFrame(buffered);
      taken !== undefined;
      taken = takeFrame(buffered)
    ) {
      buffered = taken.rest;
      handler(taken.frame);
    }
  });
  socket.resume();
}

/**
 * The hello of a master: the five bytes of a hello frame. It rejects with
 * `notHello` when the socket closes first, or at the first byte that is not
 * the hello's, so a peer that speaks another protocol, such as an OpenSSH
 * master (PROTOCOL.mux starts with a length), fails at once. The socket is
 * paused after it, with the bytes after the hello put back.
 */
export function readHello(socket: Socket, notHello: Error): Promise<void> {
  const hello = encode(FrameType.hello);
  const read = Promise.withResolvers<void>();
  let buffered: Buffer = Buffer.alloc(0);
  const stop = (): void => {
    socket.off('data', onData);
    socket.off('close', onClose);
    socket.pause();
  };
  const onClose = (): void => read.reject(notHello);
  const onData = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk]);
    const length = Math.min(buffered.length, hello.length);
    if (!buffered.subarray(0, length).equals(hello.subarray(0, length))) {
      stop();
      read.reject(notHello);
      return;
    }
    if (buffered.length < hello.length) return;
    stop();
    const rest = buffered.subarray(hello.length);
    if (rest.length > 0) socket.unshift(rest);
    read.resolve();
  };
  socket.resume();
  socket.on('data', onData);
  socket.once('close', onClose);
  return read.promise;
}
