import { createHash } from 'node:crypto';

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

/** The kind of a lease: `process` for a test process that reuses shared servers, `sweep` for a teardown that removes them. */
export const LEASE_LABEL = 'dev.zukhruf.testing.lease';

/** The smallest image with `cat`. A missing image is pulled by the caller. */
export const LEASE_IMAGE = 'busybox:1.37.0';

/** The time a `created` lease gets to start before a waiter removes it, and between two looks of a waiter. */
const PATIENCE = 5_000;

/** The states of a lease that ended: no holder can have it. */
const endedStates = new Set(['exited', 'dead']);

/** The name of the sweep lease of `version` on an engine. */
export function sweepLeaseName(version: string): string {
  return `zukhruf-testing-sweep-${createHash('sha256').update(version).digest('hex')}`;
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
 * removes the container. The attach does not keep the holder running.
 */
export class EngineLease implements AsyncDisposable {
  readonly #container: OwnedContainer;
  readonly #attach: ContainerProcess;

  private constructor(container: OwnedContainer, attach: ContainerProcess) {
    this.#container = container;
    this.#attach = attach;
  }

  /** Resolves when the attach ends: the lease is gone. */
  async closed(): Promise<void> {
    await this.#attach.exitCode.catch(() => {});
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
          Entrypoint: ['cat'],
          Cmd: [],
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
      await container.remove({ force: true }).catch(() => {});
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
    cancel: CancelOptions = {},
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
      if (await removedWithin(lease, cancel)) return;
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

/** True when the lease is gone within PATIENCE, false when it is still there. */
async function removedWithin(
  lease: Container,
  { signal }: CancelOptions,
): Promise<boolean> {
  const patience = AbortSignal.timeout(PATIENCE);
  try {
    await lease.wait({
      condition: 'removed',
      signal:
        signal === undefined ? patience : AbortSignal.any([signal, patience]),
    });
    return true;
  } catch (error) {
    if (error instanceof ContainerNotFoundError) return true;
    if (signal?.aborted || !patience.aborted) throw error;
    return false;
  }
}
