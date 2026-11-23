import { type Interface, createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import { leaveErrorsToClose } from '../lock-stores/socket/leave-errors-to-close.ts';

/**
 * The lines that a test reads from a socket. readline emits the errors of its
 * input again, and Linux resets a socket that closed with data its peer did
 * not read, so the interface leaves its errors to the socket's close, as the
 * socket connection of production does (socket-connection.ts).
 */
export function linesOf(input: Readable): Interface {
  const lines = createInterface({ input });
  leaveErrorsToClose(lines);
  return lines;
}
