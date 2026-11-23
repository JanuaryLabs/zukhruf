/**
 * No server listens on the pipe: nothing is at the path, a dead server's file
 * is there, a file that is not a socket is there (macOS), or the server closed
 * before it accepted the connection (Linux). `cause` is the error of Node.js.
 */
export class NoServerError extends Error {
  /** The path that the connect tried. */
  readonly path: string;

  constructor(path: string, options: { cause: unknown }) {
    super(`No server listens on ${path}`, options);
    this.name = 'NoServerError';
    this.path = path;
  }
}
