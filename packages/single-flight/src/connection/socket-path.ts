import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

/** macOS allows 104 bytes including the terminating NUL; Linux allows 108. */
const SOCKET_PATH_LIMIT = 103;

/**
 * A Unix socket file in the directory on macOS and Linux. On Windows, a named
 * pipe: pipe names are global, so the name comes from the directory, and
 * Windows paths ignore case, so the path is lowercased first.
 */
export function socketPathFor(directory: string): string {
  if (process.platform === 'win32') {
    const id = createHash('sha256')
      .update(resolve(directory).toLowerCase())
      .digest('hex')
      .slice(0, 32);
    return `\\\\.\\pipe\\single-flight-${id}`;
  }
  const socketPath = join(directory, 'flight.sock');
  if (Buffer.byteLength(socketPath) > SOCKET_PATH_LIMIT) {
    throw new RangeError(
      `The socket path ${socketPath} exceeds ${SOCKET_PATH_LIMIT} bytes; choose a shorter directory.`,
    );
  }
  return socketPath;
}
