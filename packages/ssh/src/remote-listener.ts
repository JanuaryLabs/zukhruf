import { Future } from '@zukhruf/async';

interface Phase {
  close(): Promise<void>;
}

const bridge: {
  construct: (
    network: 'tcp' | 'unix',
    address: string,
    cancel: () => Promise<void>,
  ) => RemoteListener;
} = {
  construct: () => {
    throw new Error('ssh: the RemoteListener class has not loaded');
  },
};

/** A listener whose close() runs `cancel` once. Not in the API: Client.listen calls it. */
export function createRemoteListener(
  network: 'tcp' | 'unix',
  address: string,
  cancel: () => Promise<void>,
): RemoteListener {
  return bridge.construct(network, address, cancel);
}

/** A socket that the server listens on for the client. */
export class RemoteListener implements AsyncDisposable {
  static {
    bridge.construct = (network, address, cancel) =>
      new RemoteListener(network, address, cancel);
  }

  readonly network: 'tcp' | 'unix';
  /** For port 0, the port that the server chose. */
  readonly address: string;
  #phase: Phase;

  private constructor(
    network: 'tcp' | 'unix',
    address: string,
    cancel: () => Promise<void>,
  ) {
    this.network = network;
    this.address = address;
    this.#phase = {
      close: () => {
        const cancelled = Future.run(cancel);
        this.#phase = { close: () => cancelled.wait() };
        return cancelled.wait();
      },
    };
  }

  /** cancel-tcpip-forward or cancel-streamlocal-forward@openssh.com. A later call waits for the same cancel. */
  close(): Promise<void> {
    return this.#phase.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
