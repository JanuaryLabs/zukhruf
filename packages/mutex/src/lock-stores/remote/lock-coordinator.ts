import { Latch, untilAborted } from '@zukhruf/async';
import {
  EpochExhaustedError,
  FencingToken,
  type TokenSource,
} from '@zukhruf/fencing';

import type { LockHandle } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { MemoryStore } from '../memory/memory-store.ts';
import type { Connection } from './connection.ts';
import {
  type LockRequest,
  type LockResponse,
  isLockRequest,
} from './protocol.ts';

export interface LockCoordinatorOptions {
  tokens: TokenSource;
  /**
   * Milliseconds after start during which nothing is granted, so holders from a
   * previous coordinator can reassert their keys first. Zero when no earlier
   * coordinator can have left a holder.
   */
  graceWindow?: number;
  /**
   * Called when the epoch of the token source has no tokens left. The request
   * that found it gets no answer: only a new term can grant it, so the owner
   * ends this term, and its peers ask the next leader (ADR 0019). Without it,
   * the request is answered `failed` like any other failed mint.
   */
  onTokensExhausted?: () => void;
}

interface Reassertion {
  token: FencingToken;
  lose(): void;
}

interface CoordinatorPhase {
  readonly leavesNothingToRecover: boolean;
  acquire(key: string, options: AcquireOptions): Promise<LockHandle>;
  tryAcquire(key: string): Promise<LockHandle | undefined>;
  isHeld(key: string): Promise<boolean>;
  reassert(
    key: string,
    token: FencingToken,
    lose: () => void,
  ): Promise<LockHandle> | undefined;
}

/**
 * Grants keys in FIFO order to its own callers and to peers it serves over
 * connections. A peer that disconnects releases everything it held or waited for.
 */
export class LockCoordinator implements LockStore {
  #phase: CoordinatorPhase;
  readonly #onTokensExhausted: (() => void) | undefined;

  constructor({
    tokens,
    graceWindow = 0,
    onTokensExhausted,
  }: LockCoordinatorOptions) {
    this.#onTokensExhausted = onTokensExhausted;
    const store = new MemoryStore({ tokens });
    const granting = new Granting(store);
    if (graceWindow > 0) {
      const over = new Latch();
      this.#phase = new GraceWindow(store, over, granting);
      setTimeout(() => {
        // Granting is current before the latch lets the waiters resume.
        this.#phase = granting;
        over.open();
      }, graceWindow).unref();
    } else {
      this.#phase = granting;
    }
  }

  async acquire(
    key: string,
    options: AcquireOptions = {},
  ): Promise<LockHandle> {
    return this.#phase.acquire(key, options);
  }

  /** Nothing is granted during the grace window, so a key counts as busy then. */
  async tryAcquire(key: string): Promise<LockHandle | undefined> {
    return this.#phase.tryAcquire(key);
  }

  /** Holders from before a failover reassert during the grace window, so a look waits for it to end. */
  async isHeld(key: string): Promise<boolean> {
    return this.#phase.isHeld(key);
  }

  /**
   * Whether the next coordinator would find nothing to recover: no key is
   * held, and the grace window is over or there was none.
   */
  get leavesNothingToRecover(): boolean {
    return this.#phase.leavesNothingToRecover;
  }

  serve(connection: Connection<LockResponse>): void {
    new Session(this, connection, this.#onTokensExhausted);
  }

  /**
   * Re-registers a holder from before a failover. Accepted only during the
   * grace window; for two claims on one key the newer token wins and the older
   * claim's `lose` is called. Returns `undefined` when the claim is refused.
   */
  reassert(
    key: string,
    token: FencingToken,
    lose: () => void,
  ): Promise<LockHandle> | undefined {
    return this.#phase.reassert(key, token, lose);
  }
}

/** The only phase that grants. A holder that reasserts now is too late. */
class Granting implements CoordinatorPhase {
  readonly #store: MemoryStore;

  constructor(store: MemoryStore) {
    this.#store = store;
  }

  /** A waiter has no key yet, so it asks the next coordinator again; only a holder needs a grace window. */
  get leavesNothingToRecover() {
    return !this.#store.holdsAnyKey;
  }

  acquire(key: string, { signal }: AcquireOptions): Promise<LockHandle> {
    return this.#store.acquire(key, { signal });
  }

  tryAcquire(key: string): Promise<LockHandle | undefined> {
    return this.#store.tryAcquire(key);
  }

  isHeld(key: string): Promise<boolean> {
    return this.#store.isHeld(key);
  }

  reassert(): undefined {
    return undefined;
  }
}

/** Grants nothing, so holders from a previous coordinator can reassert their keys first. */
class GraceWindow implements CoordinatorPhase {
  readonly #store: MemoryStore;
  readonly #over: Latch;
  readonly #next: Granting;
  readonly #reassertions = new Map<string, Reassertion>();

  constructor(store: MemoryStore, over: Latch, next: Granting) {
    this.#store = store;
    this.#over = over;
    this.#next = next;
  }

  /** A holder from the previous coordinator may not have reasserted its key yet, so this coordinator cannot know. */
  get leavesNothingToRecover() {
    return false;
  }

  async acquire(key: string, { signal }: AcquireOptions): Promise<LockHandle> {
    await untilAborted(this.#over.wait(), signal);
    return this.#next.acquire(key, { signal });
  }

  async tryAcquire(): Promise<undefined> {
    return undefined;
  }

  /** A holder that does not reassert before the window ends loses its key, so the answer after it is exact. */
  async isHeld(key: string): Promise<boolean> {
    await this.#over.wait();
    return this.#next.isHeld(key);
  }

  reassert(
    key: string,
    token: FencingToken,
    lose: () => void,
  ): Promise<LockHandle> | undefined {
    const existing = this.#reassertions.get(key);
    if (existing && !token.isNewerThan(existing.token)) return undefined;

    // Waiters join the line only after grace, so this claim is next once the
    // claim it outranks gives the key back, even if that claim already let it go.
    const lease = this.#store.acquire(key);
    existing?.lose();
    const claim = { token, lose };
    this.#reassertions.set(key, claim);
    // A claim whose token cannot be minted holds nothing, so it outranks no later claim.
    lease.catch(() => {
      if (this.#reassertions.get(key) === claim) this.#reassertions.delete(key);
    });
    return lease;
  }
}

class Session {
  readonly #coordinator: LockCoordinator;
  readonly #onTokensExhausted: (() => void) | undefined;
  readonly #requested = new Set<string>();
  #phase: SessionPhase;

  constructor(
    coordinator: LockCoordinator,
    connection: Connection<LockResponse>,
    onTokensExhausted: (() => void) | undefined,
  ) {
    this.#coordinator = coordinator;
    this.#onTokensExhausted = onTokensExhausted;
    this.#phase = new Serving(connection);
    connection.on('message', (message) => {
      // A message that is not a lock request is ignored, and the peer keeps its keys (ADR 0017).
      if (!isLockRequest(message)) return;
      this.#handle(message).catch((error: unknown) =>
        this.#fail(message, error),
      );
    });
    connection.once('close', () => {
      void this.#end();
    });
  }

  async #handle(request: LockRequest) {
    switch (request.op) {
      case 'acquire': {
        if (!this.#register(request.id)) return;
        const lease = await this.#coordinator.acquire(request.key);
        return this.#grant(lease, request.id);
      }
      case 'try': {
        if (!this.#register(request.id)) return;
        const lease = await this.#coordinator.tryAcquire(request.key);
        if (!lease) {
          this.#requested.delete(request.id);
          return this.#phase.reply({ op: 'busy', id: request.id });
        }
        return this.#grant(lease, request.id);
      }
      case 'isHeld': {
        const held = await this.#coordinator.isHeld(request.key);
        return this.#phase.reply({ op: 'held', id: request.id, held });
      }
      case 'cancel': {
        // A request still in line is released by #grant when its turn comes.
        this.#requested.delete(request.id);
        return this.#phase.release(request.id);
      }
      case 'release': {
        this.#requested.delete(request.id);
        return this.#phase.release(request.id);
      }
      case 'reassert': {
        // Registered like any request, so a release that arrives before the claim resolves gives the key back.
        if (!this.#register(request.id)) return;
        const claim = this.#coordinator.reassert(
          request.key,
          // isLockRequest admits only a token that parses.
          FencingToken.parse(request.token)!,
          () => this.#lose(request.id),
        );
        if (!claim) {
          this.#requested.delete(request.id);
          return this.#phase.reply({ op: 'rejected', id: request.id });
        }
        const lease = await claim;
        if (!this.#requested.has(request.id)) {
          return lease[Symbol.asyncDispose]();
        }
        return this.#phase.keep(lease, request.id);
      }
    }
  }

  /**
   * Only a token that cannot be minted makes a request fail, and only an
   * acquire, a try or a reassert mints one. The key is free again, and the
   * peer keeps its connection and every other key (ADR 0017, ADR 0019).
   */
  #fail(request: LockRequest, error: unknown) {
    this.#requested.delete(request.id);
    if (error instanceof EpochExhaustedError && this.#onTokensExhausted) {
      return this.#onTokensExhausted();
    }
    const message = error instanceof Error ? error.message : String(error);
    switch (request.op) {
      case 'acquire':
      case 'try':
        return this.#phase.reply({ op: 'failed', id: request.id, message });
      // The client reads `rejected` as a lost lease.
      case 'reassert':
        return this.#phase.reply({ op: 'rejected', id: request.id });
      // They mint no token.
      case 'isHeld':
      case 'cancel':
      case 'release':
        return;
    }
  }

  /**
   * A reconnecting client may resend a request; granting it twice would orphan
   * one lease. Returns `false` for an id this session already registered.
   */
  #register(id: string): boolean {
    if (this.#requested.has(id)) return false;
    this.#requested.add(id);
    return true;
  }

  /** A request cancelled while the grant was on its way releases the key at once. */
  #grant(lease: LockHandle, id: string) {
    if (!this.#requested.has(id)) return lease[Symbol.asyncDispose]();
    return this.#phase.grant(lease, id);
  }

  /** A newer claim outranked this session's reassertion, so the key goes to that claim next. */
  #lose(id: string) {
    // A holder that already released has nothing to give back and nothing to learn.
    if (!this.#requested.delete(id)) return;
    this.#phase.lose(id);
  }

  /** Ends Serving before its leases are released, so a grant that arrives meanwhile is given back too. */
  async #end() {
    const serving = this.#phase;
    this.#phase = new Ended();
    await serving.end();
  }
}

interface SessionPhase {
  reply(response: LockResponse): Promise<void>;
  grant(lease: LockHandle, id: string): Promise<void>;
  keep(lease: LockHandle, id: string): Promise<void>;
  release(id: string): Promise<void>;
  lose(id: string): void;
  end(): Promise<void>;
}

/** The peer is connected: the session keeps its leases and answers it. */
class Serving implements SessionPhase {
  readonly #connection: Connection<LockResponse>;
  readonly #leases = new Map<string, LockHandle>();

  constructor(connection: Connection<LockResponse>) {
    this.#connection = connection;
  }

  async reply(response: LockResponse) {
    // A failed send means the peer is gone; `close` then releases its leases.
    await this.#connection.send(response).catch(() => {});
  }

  async grant(lease: LockHandle, id: string) {
    this.#leases.set(id, lease);
    await this.reply({ op: 'granted', id, token: lease.token.toString() });
  }

  async keep(lease: LockHandle, id: string) {
    this.#leases.set(id, lease);
  }

  async release(id: string) {
    const lease = this.#leases.get(id);
    this.#leases.delete(id);
    await lease?.[Symbol.asyncDispose]();
  }

  lose(id: string) {
    void this.release(id);
    void this.reply({ op: 'rejected', id });
  }

  async end() {
    const leases = [...this.#leases.values()];
    this.#leases.clear();
    for (const lease of leases) await lease[Symbol.asyncDispose]();
  }
}

/** The peer is gone: a lease that still arrives is given back at once, and nothing is answered. */
class Ended implements SessionPhase {
  async reply() {}

  async grant(lease: LockHandle) {
    await lease[Symbol.asyncDispose]();
  }

  async keep(lease: LockHandle) {
    await lease[Symbol.asyncDispose]();
  }

  async release() {}

  lose() {}

  async end() {}
}
