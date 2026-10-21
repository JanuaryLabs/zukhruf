import type { Container } from '@zukhruf/docker';

/**
 * A container whose port answers on 127.0.0.1 of this machine, through an SSH
 * forward when the engine is remote. Disposal closes the forward. A dedicated
 * server's disposal also removes its container; a shared server's leaves it
 * running for its other users.
 */
export class ServiceContainer implements AsyncDisposable {
  readonly container: Container;
  readonly host = '127.0.0.1';
  readonly port: number;
  /** Closes the forward and leaves the container running for its other users. */
  readonly disconnect: () => Promise<void>;
  readonly #remove: (() => Promise<void>) | undefined;

  constructor(
    container: Container,
    port: number,
    disconnect: () => Promise<void>,
    remove: (() => Promise<void>) | undefined,
  ) {
    this.container = container;
    this.port = port;
    this.disconnect = disconnect;
    this.#remove = remove;
  }

  /** Removes a dedicated server's container, then closes the forward; when both fail, a SuppressedError holds both. */
  async cleanup(): Promise<void> {
    await using forward = new AsyncDisposableStack();
    forward.defer(this.disconnect);
    await this.#remove?.();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.cleanup();
  }
}
