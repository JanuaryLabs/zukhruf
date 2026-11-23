import { addAbortListener } from 'node:events';
import type { Socket } from 'node:net';

import type { Clock } from '@zukhruf/async';
import { isErrno } from '@zukhruf/fs';
import { NoServerError, PipeAddress } from '@zukhruf/pipes';

import { unrefed } from './leader-pipe.ts';
import { type LeaderRecord, readLeaderRecord } from './leader-record.ts';

/** Why a reader's leader left: it closed its pipe, or the reader ended it and then the pipe closed. */
export type Left = 'closed' | 'ended';

export interface ReaderOptions {
  clock: Clock;
  /** With `false`, neither the connection nor the deadline keeps the process alive. */
  ref: boolean;
  /** Stops the read: the connection closes, the deadline is cleared, and the read rejects with `signal.reason`. */
  signal: AbortSignal;
}

/**
 * Reads the leader record, connects to its pipe once, and resolves when the
 * leader left. Resolves `'absent'` when it holds no connection to a leader's
 * pipe: no leader serves one, the pipe is another user's, or its listen queue
 * is full.
 *
 * While connected, the reader keeps the deadline of the heartbeat: the
 * record's `leaseDuration` after the connect, and again after each heartbeat
 * (ADR 0004). When it comes, the reader sends `SIGKILL` to the process of the
 * record, only while it holds that process's pipe open, so a process id used
 * again is never hit (ADR 0006), and never to its own process. The read rejects when the kill fails with an
 * error other than `ESRCH` or `EPERM`.
 */
export async function readLeader(
  recordPath: string,
  options: ReaderOptions,
): Promise<Left | 'absent'> {
  const record = await readLeaderRecord(recordPath);
  if (record === undefined) return 'absent';
  let socket: Socket;
  try {
    socket = await new PipeAddress(record.address).connect({
      signal: options.signal,
    });
  } catch (error) {
    // No server listens on the pipe of the record, the pipe is another user's
    // (ADR 0007), or its listen queue is full (EAGAIN on Linux; macOS refuses
    // that connect as no server, #5425): a leader serves, but no connection
    // to its pipe can be held now.
    if (
      error instanceof NoServerError ||
      isErrno(error, 'EACCES') ||
      isErrno(error, 'EAGAIN')
    )
      return 'absent';
    throw error;
  }
  return untilLeft(socket, record, options);
}

function untilLeft(
  socket: Socket,
  { processId, leaseDuration }: LeaderRecord,
  { clock, ref, signal }: ReaderOptions,
): Promise<Left> {
  if (signal.aborted) {
    socket.destroy();
    return Promise.reject(signal.reason);
  }
  const { promise, resolve, reject } = Promise.withResolvers<Left>();
  let timer: unknown;
  /** The kill was sent, or the process had ended: only the close is left to wait for. */
  let ended = false;
  /** The kernel refused the kill: the reader sets no new deadline. */
  let refused = false;
  const stop = () => {
    clock.clearTimeout(timer);
    socket.destroy();
    aborting[Symbol.dispose]();
  };
  const expire = () => {
    if (socket.destroyed) return;
    // The record names the reader's own process, which runs this code and so
    // is not hung: a kill would end the reader with its leader. Refused, as a
    // kill of another user's process is.
    if (processId === process.pid) {
      refused = true;
      return;
    }
    try {
      process.kill(processId, 'SIGKILL');
      ended = true;
    } catch (error) {
      // The process ended already: its close comes, or came.
      if (isErrno(error, 'ESRCH')) ended = true;
      // Another user's process: the leader leads until it runs again or its user ends it.
      else if (isErrno(error, 'EPERM')) refused = true;
      else {
        stop();
        reject(error);
      }
    }
  };
  const arm = () => {
    if (ended || refused) return;
    clock.clearTimeout(timer);
    timer = clock.setTimeout(expire, leaseDuration);
    if (!ref) unrefed(timer);
  };
  const close = () => {
    stop();
    resolve(ended ? 'ended' : 'closed');
  };
  const aborting = addAbortListener(signal, () => {
    stop();
    reject(signal.reason);
  });
  if (!ref) socket.unref();
  socket.on('data', arm);
  socket.once('end', close);
  socket.once('close', close);
  socket.on('error', close);
  arm();
  return promise;
}
