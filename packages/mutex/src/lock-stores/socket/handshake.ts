import type { Socket } from 'node:net';

import { isRecord } from '../../shared/is-record.ts';
import { ADDED_OPS } from '../remote/protocol.ts';

/**
 * The version of the messages a socket store's processes exchange. It changes
 * only when they change, so processes that run different package versions
 * with the same protocol still share a directory. The `hello` and the
 * `refused` answer keep their shape in every version: they are how two
 * versions find out that they differ. A request added later needs no new
 * version: the `welcome` lists it (see `ADDED_OPS`).
 */
export const PROTOCOL_VERSION = 1;

/** What a leader answered to this process's `hello`. */
export type Greeting =
  /** `ops`: the added requests the leader answers; a leader of 0.3.x lists none. */
  | { kind: 'welcome'; ops: ReadonlySet<string> }
  | { kind: 'refused'; version: number }
  /** The leader closed the connection without an answer: it stops, or it predates the handshake. */
  | { kind: 'closed' };

/** Says which protocol this process speaks, and reads the leader's answer. */
export async function greet(socket: Socket): Promise<Greeting> {
  socket.write(
    `${JSON.stringify({ op: 'hello', version: PROTOCOL_VERSION })}\n`,
  );
  const answer = parse(await readLine(socket));
  if (isRecord(answer) && answer.op === 'welcome') {
    return { kind: 'welcome', ops: listedOps(answer.ops) };
  }
  if (
    isRecord(answer) &&
    answer.op === 'refused' &&
    typeof answer.version === 'number'
  ) {
    return { kind: 'refused', version: answer.version };
  }
  return { kind: 'closed' };
}

/**
 * Reads a new process's `hello`. A process that speaks this protocol is
 * welcomed. A `hello` of another version is refused with this leader's
 * version, and the connection ends once that answer is written. A process
 * that opens with anything else predates the handshake: it cannot read
 * `refused`, and it connects again at once after any hang-up. So it gets no
 * answer, and it stays connected until it hangs up or the term ends.
 */
export async function welcome(socket: Socket): Promise<boolean> {
  const hello = parse(await readLine(socket));
  if (!isRecord(hello) || hello.op !== 'hello') {
    // Flowing with no reader drops its lines, so a close behind them still ends the socket.
    socket.resume();
    return false;
  }
  if (hello.version === PROTOCOL_VERSION) {
    // A follower of 0.3.x reads only `op`, so the list is new to followers only.
    socket.write(`${JSON.stringify({ op: 'welcome', ops: [...ADDED_OPS] })}\n`);
    return true;
  }
  // Destroyed once the answer is written: a paused socket would never see a silent process hang up.
  socket.end(
    `${JSON.stringify({ op: 'refused', version: PROTOCOL_VERSION })}\n`,
    () => socket.destroy(),
  );
  return false;
}

function listedOps(ops: unknown): ReadonlySet<string> {
  if (!Array.isArray(ops)) return new Set();
  return new Set(
    ops.filter((op: unknown): op is string => typeof op === 'string'),
  );
}

function parse(line: string | undefined): unknown {
  if (line === undefined) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** A hello and each answer to it are one short line, so a longer first line is none of them. */
const FIRST_LINE_LIMIT = 1024;

/**
 * Reads exactly one line and puts back whatever arrived after it, so the
 * reader that takes over the socket next sees every later message. Resolves
 * `undefined` when the socket closes first, or when the line grows past
 * FIRST_LINE_LIMIT bytes: a process that never ends its line cannot fill the
 * memory of this one.
 */
function readLine(socket: Socket): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const chunks: Buffer[] = [];
  let lineBytes = 0;
  const stop = () => {
    socket.off('data', onData);
    socket.off('close', onClose);
    socket.pause();
  };
  const onData = (chunk: Buffer) => {
    const end = chunk.indexOf(0x0a);
    lineBytes += end === -1 ? chunk.length : end;
    if (lineBytes > FIRST_LINE_LIMIT) {
      stop();
      resolve(undefined);
      return;
    }
    if (end === -1) {
      chunks.push(chunk);
      return;
    }
    stop();
    const rest = chunk.subarray(end + 1);
    if (rest.length > 0) socket.unshift(rest);
    resolve(
      Buffer.concat([...chunks, chunk.subarray(0, end)]).toString('utf8'),
    );
  };
  const onClose = () => {
    socket.off('data', onData);
    resolve(undefined);
  };
  // Every error is followed by `close`, which reports the lost connection as no answer.
  socket.on('error', () => {});
  socket.on('data', onData);
  socket.once('close', onClose);
  return promise;
}
