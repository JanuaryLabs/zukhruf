import { type Clock, Latch, delay, untilAborted } from '@zukhruf/async';
import {
  EpochExhaustedError,
  FencingToken,
  type TokenSource,
} from '@zukhruf/fencing';
import { type Connection, ConnectionClosedError } from '@zukhruf/rpc';

import type { LockHandle } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { MemoryStore } from '../memory/memory-store.ts';
import {
  type LockRequest,
  type LockResponse,
  isLockRequest,
} from './protocol.ts';

export interface LockCoordinatorOptions {
  tokens: TokenSource;
  /**
   * The recorded sessions of the term before, after a failover (ADR 0033).
   * Nothing is granted until each of them sent its end-of-reasserts marker,
   * stopped, or let its lease duration pass on `clock`. The map gives the
   * lease duration of each session id; the deadlines start now. None when no
   * earlier coordinator can have left a holder.
   */
  recovery?: Recovery | undefined;
  /**
   * Called when the epoch of the token source has no tokens left. The request
   * that found it gets no answer: only a new term can grant it, so the owner
   * ends this term, and its peers ask the next leader (ADR 0019). Without it,
   * the request is answered `failed` like any other failed mint.
   */
  onTokensExhausted?: () => void;
}

export interface Recovery {
  sessions: ReadonlyMap<string, number>;
  clock: Clock;
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
    session: string | undefined,
  ): Promise<LockHandle> | undefined;
  /** The recorded sessions whose recovery has not ended. */
  readonly recovering: ReadonlySet<string>;
  /** The recovery of `session` ends: it sent its marker, or it stopped. */
  ended(session: string): void;
}

/**
 * Grants keys in FIFO order to its own callers and to peers it serves over
 * connections. A peer that disconnects releases everything it held or waited for.
 */
export class LockCoordinator implements LockStore {
  #phase: CoordinatorPhase;
  readonly #onTokensExhausted: (() => void) | undefined;

  constructor({ tokens, recovery, onTokensExhausted }: LockCoordinatorOptions) {
    this.#onTokensExhausted = onTokensExhausted;
    const store = new MemoryStore({ tokens });
    const granting = new Granting(store);
    if (recovery && recovery.sessions.size > 0) {
      const over = new Latch();
      this.#phase = new Recovering(store, over, granting, recovery, () => {
        // Granting is current before the latch lets the waiters resume.
        this.#phase = granting;
        over.open();
      });
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

  /** Nothing is granted during the recovery, so a key counts as busy then. */
  async tryAcquire(key: string): Promise<LockHandle | undefined> {
    return this.#phase.tryAcquire(key);
  }

  /** Holders from before a failover reassert during the recovery, so a look waits for it to end. */
  async isHeld(key: string): Promise<boolean> {
    return this.#phase.isHeld(key);
  }

  /**
   * Whether the next coordinator would find nothing to recover: no key is
   * held, and the recovery is over or there was none.
   */
  get leavesNothingToRecover(): boolean {
    return this.#phase.leavesNothingToRecover;
  }

  /**
   * Serves a peer. `session` is the id that a process of a socket store says
   * in its `hello`; an IPC channel or a worker port has none, and no recovery.
   */
  serve(connection: Connection<LockResponse>, session?: string): void {
    new Peer(this, connection, this.#onTokensExhausted, session);
  }

  /**
   * Re-registers a holder from before a failover. Accepted only from a
   * recorded session during the recovery, before its deadline; for two claims
   * on one key the newer token wins and the older claim's `lose` is called.
   * Returns `undefined` when the claim is refused.
   */
  reassert(
    key: string,
    token: FencingToken,
    lose: () => void,
    session: string | undefined,
  ): Promise<LockHandle> | undefined {
    return this.#phase.reassert(key, token, lose, session);
  }

  /** The recorded sessions whose recovery has not ended: none once the recovery is over, or when there was none. */
  get recovering(): ReadonlySet<string> {
    return this.#phase.recovering;
  }

  /**
   * Ends the recovery of `session`: it sent its marker, or its presence is
   * free. Nothing changes for a session whose recovery already ended.
   */
  ended(session: string): void {
    this.#phase.ended(session);
  }
}

const nobody: ReadonlySet<string> = new Set();

/** The only phase that grants. A holder that reasserts now is too late. */
class Granting implements CoordinatorPhase {
  readonly #store: MemoryStore;

  constructor(store: MemoryStore) {
    this.#store = store;
  }

  /** A waiter has no key yet, so it asks the next coordinator again; only a holder needs a recovery. */
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

  get recovering() {
    return nobody;
  }

  /** A marker after the recovery, or on a channel that has none, changes nothing. */
  ended() {}
}

/**
 * Grants nothing until each recorded session of the term before ended its
 * recovery: it sent its end-of-reasserts marker, it stopped, or its lease
 * duration passed (ADR 0033). Only those sessions can hold a key of an
 * earlier term, so after them nobody can.
 */
class Recovering implements CoordinatorPhase {
  readonly #store: MemoryStore;
  readonly #over: Latch;
  readonly #next: Granting;
  readonly #reassertions = new Map<string, Reassertion>();
  /** The sessions that may still reassert: recorded, and still within their lease duration. */
  readonly #admitted: Set<string>;
  readonly #waiting: Set<string>;
  readonly #finish: () => void;

  constructor(
    store: MemoryStore,
    over: Latch,
    next: Granting,
    { sessions, clock }: Recovery,
    finish: () => void,
  ) {
    this.#store = store;
    this.#over = over;
    this.#next = next;
    this.#finish = finish;
    this.#admitted = new Set(sessions.keys());
    this.#waiting = new Set(sessions.keys());
    for (const [session, leaseDuration] of sessions) {
      // A deadline after the end of the recovery changes nothing, so none is cancelled.
      void delay(leaseDuration, { clock, signal: undefined, ref: false }).then(
        () => this.#missed(session),
      );
    }
  }

  /** A recorded session may still hold a key that it has not reasserted, so this coordinator cannot know. */
  get leavesNothingToRecover() {
    return false;
  }

  get recovering(): ReadonlySet<string> {
    return this.#waiting;
  }

  async acquire(key: string, { signal }: AcquireOptions): Promise<LockHandle> {
    await untilAborted(this.#over.wait(), signal);
    return this.#next.acquire(key, { signal });
  }

  async tryAcquire(): Promise<undefined> {
    return undefined;
  }

  /** Each recorded session reasserted its keys or can no longer, so the answer after the recovery is exact. */
  async isHeld(key: string): Promise<boolean> {
    await this.#over.wait();
    return this.#next.isHeld(key);
  }

  reassert(
    key: string,
    token: FencingToken,
    lose: () => void,
    session: string | undefined,
  ): Promise<LockHandle> | undefined {
    if (session === undefined || !this.#admitted.has(session)) {
      return undefined;
    }
    const existing = this.#reassertions.get(key);
    if (existing && !token.isNewerThan(existing.token)) return undefined;

    // Waiters join the line only after the recovery, so this claim is next once
    // the claim it outranks gives the key back, even if that claim already let it go.
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

  ended(session: string) {
    if (!this.#waiting.delete(session)) return;
    if (this.#waiting.size > 0) return;
    this.#finish();
  }

  /** The session can still run, for example after SIGCONT, but a later reassert of it is refused. */
  #missed(session: string) {
    this.#admitted.delete(session);
    this.ended(session);
  }
}

class Peer {
  readonly #coordinator: LockCoordinator;
  readonly #onTokensExhausted: (() => void) | undefined;
  readonly #session: string | undefined;
  readonly #requested = new Set<string>();
  #phase: SessionPhase;

  constructor(
    coordinator: LockCoordinator,
    connection: Connection<LockResponse>,
    onTokensExhausted: (() => void) | undefined,
    session: string | undefined,
  ) {
    this.#coordinator = coordinator;
    this.#onTokensExhausted = onTokensExhausted;
    this.#session = session;
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
          this.#session,
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
      case 'reasserted': {
        if (this.#session !== undefined) {
          this.#coordinator.ended(this.#session);
        }
        return;
      }
    }
  }

  /**
   * Only a token that cannot be minted makes a request fail, and only an
   * acquire, a try or a reassert mints one. The key is free again, and the
   * peer keeps its connection and every other key (ADR 0017, ADR 0019).
   */
  #fail(request: LockRequest, error: unknown) {
    if (request.op === 'reasserted') throw error;
    this.#requested.delete(request.id);
    if (error instanceof EpochExhaustedError && this.#onTokensExhausted) {
      return this.#onTokensExhausted();
    }
    const message = Error.isError(error) ? error.message : String(error);
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
    try {
      await this.#connection.send(response);
    } catch (error) {
      // The peer is gone; `close` then releases its leases.
      if (!(error instanceof ConnectionClosedError)) throw error;
    }
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
