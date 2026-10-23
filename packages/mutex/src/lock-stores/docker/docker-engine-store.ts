import { setTimeout as delay } from 'node:timers/promises';

import {
  type CancelOptions,
  type Container,
  ContainerNotFoundError,
  type ContainerProcess,
  ContainerRunningError,
  type Docker,
  NameConflictError,
} from '@zukhruf/docker';
import { FencingToken } from '@zukhruf/fencing';
import { LeaseController } from '@zukhruf/lease';

import type { LockHandle } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { InProcessTurns } from '../../shared/in-process-turns.ts';
import { keyDigest } from '../../shared/key-digest.ts';

export interface DockerEngineStoreOptions {
  /** The client of the engine. The caller owns it; its disposal ends each attach, so each held key is lost. */
  docker: Docker;
  /** The image of each claim. It must be on the engine and have `cat` on its `PATH`; the store never pulls it. */
  image: string;
  /** The first part of each name and the value of the label `zukhruf.mutex.namespace`. Stores with one namespace on one engine share their locks. */
  namespace: string;
  /**
   * Milliseconds between two heartbeats of a holder, and the time limit of
   * each heartbeat: the longest time that a holder can work after its claim
   * ended, before its signal aborts. It is also the time that a waiter gives
   * a `created` claim before it removes it.
   */
  heartbeatInterval: number;
}

const namespaceLabel = 'zukhruf.mutex.namespace';
const keyLabel = 'zukhruf.mutex.key';
const tokenLabel = 'zukhruf.mutex.token';

/** The states of a claim that no other caller can take the key from. */
const holdingStates = new Set(['created', 'running', 'paused', 'restarting']);

/**
 * Holds a key as a named container on one Docker engine: the claim. The claim
 * runs `cat` on the standard input of the attach of its holder, so it ends
 * and the engine removes it when the attach ends. Every process on every
 * machine that reaches the engine shares the locks.
 *
 * Callers in this process first line up in a queue in memory, so one process
 * makes at most one claim attempt for each key, in the order of the calls.
 */
export class DockerEngineStore implements LockStore {
  readonly #turns = new InProcessTurns();
  readonly #options: DockerEngineStoreOptions;

  constructor(options: DockerEngineStoreOptions) {
    this.#options = options;
  }

  acquire(key: string, options?: AcquireOptions): Promise<LockHandle> {
    return this.#turns.acquire(key, options, async () => {
      const signal = options?.signal;
      const claims = new Claims(key, this.#options);
      const cancel: CancelOptions = signal === undefined ? {} : { signal };
      for (;;) {
        signal?.throwIfAborted();
        const claim = await claims.create(signal);
        if (claim === undefined) {
          await claims.waitForRelease(cancel);
          continue;
        }
        const handle = await claim.hold();
        if (handle !== undefined) return handle;
      }
    });
  }

  tryAcquire(key: string): Promise<LockHandle | undefined> {
    return this.#turns.tryAcquire(key, async () => {
      const claim = await new Claims(key, this.#options).create(undefined);
      return claim?.hold();
    });
  }

  /** Reads the state of the claim, and never creates a container or mints a token. */
  async isHeld(key: string): Promise<boolean> {
    const claim = await this.#options.docker.containers.find(
      claimName(key, this.#options.namespace),
    );
    if (claim === undefined) return false;
    return holdingStates.has((await stateOf(claim)) ?? '');
  }
}

/** The key digest in hexadecimal. */
function digestOf(key: string): string {
  return keyDigest(key).toString('hex');
}

function claimName(key: string, namespace: string): string {
  return `${namespace}-${digestOf(key)}`;
}

/** The state of the container, or undefined when it is gone. */
async function stateOf(
  container: Container,
  cancel: CancelOptions = {},
): Promise<string | undefined> {
  try {
    return (await container.inspect(cancel)).State?.Status;
  } catch (error) {
    if (error instanceof ContainerNotFoundError) return undefined;
    throw error;
  }
}

/** The claims of one key: their create, and the wait of a caller that did not get the name. */
class Claims {
  readonly #key: string;
  readonly #options: DockerEngineStoreOptions;
  readonly #name: string;

  constructor(key: string, options: DockerEngineStoreOptions) {
    this.#key = key;
    this.#options = options;
    this.#name = claimName(key, options.namespace);
  }

  /** The new claim, or undefined when another caller has the name. A cancel after the create removes the new claim. */
  async create(signal: AbortSignal | undefined): Promise<Claim | undefined> {
    const { docker, image, namespace } = this.#options;
    let container: Container;
    try {
      container = await docker.containers.create(
        {
          Image: image,
          Entrypoint: ['cat'],
          Cmd: [],
          OpenStdin: true,
          StdinOnce: true,
          AttachStdin: true,
          Labels: { [namespaceLabel]: namespace, [keyLabel]: this.#key },
          HostConfig: { AutoRemove: true },
        },
        { name: this.#name },
      );
    } catch (error) {
      if (error instanceof NameConflictError) return undefined;
      throw error;
    }
    if (signal?.aborted) {
      await container.remove({ force: true });
      throw signal.reason;
    }
    return new Claim(container, this.#key, this.#options);
  }

  /**
   * Waits by ID for the claim that has the name, so that a release before the
   * wait is never lost. A `created` claim gets `heartbeatInterval`, and then a
   * removal without force: the engine lets only one of that removal and the
   * start of its caller succeed.
   */
  async waitForRelease(cancel: CancelOptions): Promise<void> {
    const { signal } = cancel;
    const claim = await this.#options.docker.containers.find(
      this.#name,
      cancel,
    );
    if (claim === undefined) return;
    if ((await stateOf(claim, cancel)) !== 'created') {
      await untilRemoved(claim, cancel);
      return;
    }
    const patience = AbortSignal.timeout(this.#options.heartbeatInterval);
    try {
      await untilRemoved(claim, {
        signal:
          signal === undefined ? patience : AbortSignal.any([signal, patience]),
      });
      return;
    } catch (error) {
      if (signal?.aborted || !patience.aborted) throw error;
    }
    if ((await stateOf(claim, cancel)) !== 'created') return;
    try {
      await claim.remove({ force: false, ...cancel });
    } catch (error) {
      if (!(error instanceof ContainerRunningError)) throw error;
    }
  }
}

async function untilRemoved(
  claim: Container,
  cancel: CancelOptions,
): Promise<void> {
  try {
    await claim.wait({ condition: 'removed', ...cancel });
  } catch (error) {
    if (error instanceof ContainerNotFoundError) return;
    throw error;
  }
}

/** A claim that this caller created: it attaches, starts, mints and confirms, then holds with a heartbeat. */
class Claim {
  readonly #container: Container;
  readonly #key: string;
  readonly #options: DockerEngineStoreOptions;
  readonly #lease: LeaseController;
  /** Aborts when the store stops holding: a release, or a lost claim. */
  readonly #done = new AbortController();

  constructor(
    container: Container,
    key: string,
    options: DockerEngineStoreOptions,
  ) {
    this.#container = container;
    this.#key = key;
    this.#options = options;
    this.#lease = new LeaseController(key);
  }

  /** The handle of the key, or undefined when a waiter removed the claim before its start, or the claim ended during the mint. */
  async hold(): Promise<LockHandle | undefined> {
    let attach: ContainerProcess;
    let token: FencingToken;
    try {
      // The attach comes before the start, so the claim never runs without it.
      attach = await this.#container.attach({ stdin: true });
      const ended = attach.exitCode;
      ended.catch(() => {});
      await this.#container.start();
      token = await this.#mint();
      if ((await stateOf(this.#container)) === undefined) return undefined;
      ended.then(
        (code) =>
          this.#lose(new Error(`The claim exited with the code ${code}.`)),
        (cause: unknown) => this.#lose(cause),
      );
    } catch (error) {
      if (error instanceof ContainerNotFoundError) return undefined;
      await this.#container.remove({ force: true });
      throw error;
    }
    void this.#beat();
    return {
      token,
      signal: this.#lease.signal,
      [Symbol.asyncDispose]: () => this.#release(),
    };
  }

  /**
   * Creates the rung above the highest rung of the ladder of the key, climbs
   * on a taken name, then removes the rungs that it read. A rung goes only
   * after a higher one exists, so a list always finds the highest rung.
   */
  async #mint(): Promise<FencingToken> {
    const { docker, namespace } = this.#options;
    const digest = digestOf(this.#key);
    const prefix = `${namespace}-${digest}-token-`;
    const rungs = await docker.volumes.list({
      filters: {
        label: [`${namespaceLabel}=${namespace}`, `${tokenLabel}=${digest}`],
      },
    });
    let rung = 0;
    for (const { Name } of rungs) {
      if (!Name.startsWith(prefix)) continue;
      const number = Number(Name.slice(prefix.length));
      if (Number.isSafeInteger(number) && number > rung) rung = number;
    }
    for (;;) {
      rung += 1;
      try {
        await docker.volumes.create({
          Name: `${prefix}${rung}`,
          Labels: { [namespaceLabel]: namespace, [tokenLabel]: digest },
        });
        break;
      } catch (error) {
        if (!(error instanceof NameConflictError)) throw error;
      }
    }
    for (const { Name } of rungs) {
      await (await docker.volumes.find(Name))?.remove();
    }
    return new FencingToken(BigInt(rung));
  }

  /** Inspects the claim each interval. A claim that is gone or does not run, or a failed or late answer, loses the lease. */
  async #beat(): Promise<void> {
    const interval = this.#options.heartbeatInterval;
    const done = this.#done.signal;
    try {
      for (;;) {
        await delay(interval, undefined, { signal: done });
        const state = await stateOf(this.#container, {
          signal: AbortSignal.any([done, AbortSignal.timeout(interval)]),
        });
        if (state !== 'running') {
          throw new Error(
            state === undefined
              ? 'The claim is gone.'
              : `The claim is ${state}.`,
          );
        }
      }
    } catch (cause) {
      if (!done.aborted) this.#lose(cause);
    }
  }

  /** Another caller can have the key now. A claim that still runs is removed, so that waiters do not wait for it. */
  #lose(cause: unknown): void {
    if (this.#done.signal.aborted) return;
    this.#done.abort();
    this.#lease.lose(cause);
    // Nobody waits for this removal; a failed one leaves the claim to the end of its attach.
    this.#container.remove({ force: true }).catch(() => {});
  }

  /** Removes the claim by its ID, so that a release never removes the claim of a later holder. */
  async #release(): Promise<void> {
    if (this.#done.signal.aborted) return;
    this.#done.abort();
    try {
      await this.#container.remove({ force: true });
    } catch (cause) {
      this.#lease.lose(cause);
      return;
    }
    this.#lease.end();
  }
}
