/** A handle of the event loop that keeps the process alive while it is ref'd: a socket, a server, a timer, a client. libuv's `uv_ref` and `uv_unref`. */
export interface Referable {
  ref(): unknown;
  unref(): unknown;
}

/**
 * Keeps a handle ref'd while work holds it, and unrefs it when no work does,
 * so an idle handle does not keep the process alive. Each `hold` gives a
 * token, and the count holds the token until a dispose. The first hold refs
 * the handle and the dispose of the last unrefs it; the constructor leaves
 * the handle as it is. Node's own `refCounted` and `unrefCounted` of the IPC
 * channel of a child process work the same way.
 */
export class RefCount {
  readonly #handle: Referable;
  /** The tokens that their holders have not disposed yet, so a second dispose of one token counts nothing. */
  readonly #holds = new Set<Disposable>();

  constructor(handle: Referable) {
    this.#handle = handle;
  }

  /** Holds the handle ref'd until the token is disposed: `using _work = refs.hold()`. */
  hold(): Disposable {
    const token: Disposable = {
      [Symbol.dispose]: () => {
        if (this.#holds.delete(token) && this.#holds.size === 0) {
          this.#handle.unref();
        }
      },
    };
    this.#holds.add(token);
    if (this.#holds.size === 1) this.#handle.ref();
    return token;
  }
}
