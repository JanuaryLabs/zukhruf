import type { Socket } from 'node:net';

import { isRecord } from '../../shared/is-record.ts';

/**
 * The version of the messages a socket store's processes exchange. It changes
 * only when they change, so processes that run different package versions
 * with the same protocol still share a directory.
 */
export const PROTOCOL_VERSION = 1;

/** What a leader answered to this process's `hello`. */
export type Greeting =
  | { kind: 'welcome' }
  | { kind: 'refused'; version: number }
  /** The leader closed the connection without an answer: it stops, or it predates the handshake. */
  | { kind: 'closed' };

/** Says which protocol this process speaks, and reads the leader's answer. */
export async function greet(socket: Socket): Promise<Greeting> {
  socket.write(
    `${JSON.stringify({ op: 'hello', version: PROTOCOL_VERSION })}\n`,
  );
  const answer = parse(await readLine(socket));
  if (isRecord(answer) && answer.op === 'welcome') return { kind: 'welcome' };
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
 * Reads a new peer's `hello`. A peer that speaks this protocol is welcomed;
 * any other first line is refused with this leader's version, and the
 * connection ends once that answer is written.
 */
export async function welcome(socket: Socket): Promise<boolean> {
  const hello = parse(await readLine(socket));
  if (
    isRecord(hello) &&
    hello.op === 'hello' &&
    hello.version === PROTOCOL_VERSION
  ) {
    socket.write(`${JSON.stringify({ op: 'welcome' })}\n`);
    return true;
  }
  // Destroyed once the answer is written: a paused socket would never see a silent peer hang up.
  socket.end(
    `${JSON.stringify({ op: 'refused', version: PROTOCOL_VERSION })}\n`,
    () => socket.destroy(),
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

/**
 * Reads exactly one line and puts back whatever arrived after it, so the
 * reader that takes over the socket next sees every later message. Resolves
 * `undefined` when the socket closes first.
 */
function readLine(socket: Socket): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const chunks: Buffer[] = [];
  const onData = (chunk: Buffer) => {
    const end = chunk.indexOf(0x0a);
    if (end === -1) {
      chunks.push(chunk);
      return;
    }
    socket.off('data', onData);
    socket.off('close', onClose);
    socket.pause();
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
  // Every error is followed by `close`, which reports the lost peer as no answer.
  socket.on('error', () => {});
  socket.on('data', onData);
  socket.once('close', onClose);
  return promise;
}
