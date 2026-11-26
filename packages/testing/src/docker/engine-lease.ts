import { type Clock, Latch, timeout } from '@zukhruf/async';
import {
  type CancelOptions,
  type Container,
  ContainerNotFoundError,
  type ContainerProcess,
  ContainerRunningError,
  type Docker,
  NameConflictError,
  type OwnedContainer,
} from '@zukhruf/docker';

/**
 * The kind of a lease: `process` for a test process that reuses shared
 * servers, `sweep` for a teardown that removes them, `creator` for the
 * process that creates the reaper of its run, until its first hold.
 */
export const LEASE_LABEL = 'dev.zukhruf.testing.lease';

/** The fingerprint of the shared server that a lease is for (ADR 0019). */
export const LEASED_SERVER_LABEL = 'dev.zukhruf.testing.lease.server';

/** The smallest image with `sh`, `cat`, `head` and `timeout`. A missing image is pulled by the caller. */
export const LEASE_IMAGE = 'busybox:1.37.0';

/** The time a `created` lease gets to start before a waiter removes it, and between two looks of a waiter. */
const PATIENCE = 5_000;

/**
 * The seconds between two keep-alive bytes of a lease (root ADR 0012): the
 * keep-alive idle time and interval of Go, which the connections of Ryuk use.
 */
const KEEP_ALIVE_INTERVAL = 15;

/**
 * The command of a lease. `cat` holds the lease until the attach ends. While
 * `cat` runs, the shell writes one keep-alive byte to the attach each
 * KEEP_ALIVE_INTERVAL seconds, so the kernel of the engine's host ends the
 * connection of a holder that went away with no close (root ADR 0012). `cat`
 * writes to `/dev/null`, and its fd 4 holds the pipe to the writer: `head`
 * reads the end of that pipe when `cat` ends, and the writer ends. A byte
 * comes at the status of `timeout` at its limit: 124 from GNU `timeout`, 141
 * from BusyBox `timeout`, which gives the status of its program. Any other
 * status stops the writer, and `cat` still holds.
 */
const LEASE_COMMAND = `cat 4>&1 > /dev/null | { while :; do timeout -s PIPE ${KEEP_ALIVE_INTERVAL} head -c 1 > /dev/null; case $? in 124|141) printf . ;; *) break ;; esac; done; }`;

/** The states of a lease that ended: no holder can have it. */
const endedStates = new Set(['exited', 'dead']);

/** The name of the sweep lease of the shared server of `fingerprint` on an engine. */
export function sweepLeaseName(fingerprint: string): string {
  return `zukhruf-testing-sweep-${fingerprint}`;
}

/** The state of the container, or undefined when it is gone. */
async function stateOf(
  container: Container,
  cancel: CancelOptions,
): Promise<string | undefined> {
  try {
    return (await container.inspect(cancel)).State?.Status;
  } catch (error) {
    if (error instanceof ContainerNotFoundError) return undefined;
    throw error;
  }
}

/** Removes the lease without force: the engine lets only one of this removal and the start of a `created` lease succeed. */
async function removeUnlessRunning(
  lease: Container,
  cancel: CancelOptions,
): Promise<void> {
  try {
    await lease.remove({ force: false, ...cancel });
  } catch (error) {
    if (!(error instanceof ContainerRunningError)) throw error;
  }
}

/**
 * A lease on one engine (Gray & Cheriton): a container that runs `cat` on
 * the standard input of the attach of its holder. When the holder process
 * exits for any reason, the attach closes, `cat` exits and the engine
 * removes the container. The attach does not keep the holder running. The
 * lease reads and drops the keep-alive bytes on the attach,
 * so the output never fills.
 */
export class EngineLease implements AsyncDisposable {
  readonly #container: OwnedContainer;
  /** Opens when the exit code of the attach came and its output ended or failed. */
  readonly #ended = new Latch();

  private constructor(container: OwnedContainer, attach: ContainerProcess) {
    this.#container = container;
    void Promise.allSettled([attach.exitCode, drained(attach)]).then(() =>
      this.#ended.open(),
    );
  }

  /** The id of the lease's container, which a reaper watches for its end. */
  get id(): string {
    return this.#container.id;
  }

  /** Resolves when the attach ends: the lease is gone. */
  async closed(): Promise<void> {
    await this.#ended.wait();
  }

  /**
   * Creates, attaches to and starts a lease. Gives undefined when another
   * holder has `name`, or when a waiter removed the lease before its start.
   * A missing image rejects with ImageNotFoundError.
   */
  static async take(
    docker: Docker,
    labels: Record<string, string>,
    options: CancelOptions & { name?: string } = {},
  ): Promise<EngineLease | undefined> {
    let container: OwnedContainer;
    try {
      container = await docker.containers.create(
        {
          Image: LEASE_IMAGE,
          Entrypoint: ['sh'],
          // socktainer 1.6.1 runs the image's own Cmd when Cmd is empty (#4205).
          Cmd: ['-c', LEASE_COMMAND],
          OpenStdin: true,
          StdinOnce: true,
          AttachStdin: true,
          Labels: labels,
          HostConfig: { AutoRemove: true },
        },
        options,
      );
    } catch (error) {
      if (error instanceof NameConflictError) return undefined;
      throw error;
    }
    try {
      // The attach comes before the start, so the lease never runs without it.
      const attach = await container.attach({ stdin: true, ref: false });
      await container.start();
      return new EngineLease(container, attach);
    } catch (error) {
      if (error instanceof ContainerNotFoundError) return undefined;
      await using removal = new AsyncDisposableStack();
      removal.defer(() => container.remove({ force: true }));
      throw error;
    }
  }

  /**
   * Resolves when the lease named `name` is gone. A `running` lease can have
   * a live holder, so the wait goes on. A lease that stays `created` for
   * PATIENCE, or that ended, has no holder: the waiter removes it.
   */
  static async gone(
    docker: Docker,
    name: string,
    { clock, ...cancel }: CancelOptions & { clock: Clock },
  ): Promise<void> {
    const lease = await docker.containers.find(name, cancel);
    if (lease === undefined) return;
    let state = await stateOf(lease, cancel);
    for (;;) {
      if (state === undefined) return;
      if (endedStates.has(state)) {
        await removeUnlessRunning(lease, cancel);
        return;
      }
      const seen = state;
      if (await removedWithin(lease, cancel, clock)) return;
      state = await stateOf(lease, cancel);
      if (seen === 'created' && state === 'created') {
        await removeUnlessRunning(lease, cancel);
        return;
      }
    }
  }

  /** Ends the lease: the removal ends its attach. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.#container.remove({ force: true });
    await this.closed();
  }
}

/** Reads the output of the attach to its end: the keep-alive bytes of the lease. */
async function drained(attach: ContainerProcess): Promise<void> {
  const output = attach[Symbol.asyncIterator]();
  while ((await output.next()).done !== true);
}

/** True when the lease is gone within PATIENCE, false when it is still there. */
async function removedWithin(
  lease: Container,
  { signal }: CancelOptions,
  clock: Clock,
): Promise<boolean> {
  using patience = timeout(PATIENCE, { clock });
  try {
    await lease.wait({
      condition: 'removed',
      signal:
        signal === undefined
          ? patience.signal
          : AbortSignal.any([signal, patience.signal]),
    });
    return true;
  } catch (error) {
    if (error instanceof ContainerNotFoundError) return true;
    if (signal?.aborted || !patience.signal.aborted) throw error;
    return false;
  }
}
