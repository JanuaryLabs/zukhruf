import type { Socket } from 'node:net';

import { isRecord } from '../../shared/is-record.ts';
import { jsonLine } from './json-line.ts';
import { leaveErrorsToClose } from './leave-errors-to-close.ts';

/**
 * The version of the messages a socket store's processes exchange. It changes
 * whenever a message changes. The `hello` and the `refused` answer keep their
 * shape in every version: they are how a leader and a process find out that
 * they cannot read each other.
 */
export const PROTOCOL_VERSION = 2;

/** What a leader answered to this process's `hello`. */
export type Greeting =
  | { kind: 'welcome' }
  | { kind: 'refused'; version: number }
  /** The leader closed the connection without an answer: it stops. */
  | { kind: 'closed' };

/** Says which protocol this process speaks, and reads the leader's answer. */
export async function greet(socket: Socket): Promise<Greeting> {
  socket.write(jsonLine({ op: 'hello', version: PROTOCOL_VERSION }));
  const answer = parse(await readLine(socket));
  if (isRecord(answer) && answer.op === 'welcome') {
    return { kind: 'welcome' };
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
 * Reads a new process's first line. A `hello` of this protocol is welcomed.
 * Anything else, a `hello` of another version included, is refused with this
 * leader's version, and the connection ends once that answer is written.
 */
export async function welcome(socket: Socket): Promise<boolean> {
  const hello = parse(await readLine(socket));
  if (
    isRecord(hello) &&
    hello.op === 'hello' &&
    hello.version === PROTOCOL_VERSION
  ) {
    socket.write(jsonLine({ op: 'welcome' }));
    return true;
  }
  // Destroyed once the answer is written: a paused socket would never see a silent process hang up.
  socket.end(jsonLine({ op: 'refused', version: PROTOCOL_VERSION }), () =>
    socket.destroy(),
  );
  return false;
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
  leaveErrorsToClose(socket);
  socket.on('data', onData);
  socket.once('close', onClose);
  return promise;
}
