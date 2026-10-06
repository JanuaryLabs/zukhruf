import { FencingToken } from '../../fencing/fencing-token.ts';
import type { TokenSource } from '../../fencing/token-source.ts';
import type { Lease } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { Latch } from '../../shared/latch.ts';
import { untilAborted } from '../../shared/until-aborted.ts';
import { MemoryStore } from '../memory/memory-store.ts';
import type { Connection } from './connection.ts';
import type { LockRequest, LockResponse } from './protocol.ts';

export interface LockCoordinatorOptions {
  tokens: TokenSource;
  /**
   * Milliseconds after start during which nothing is granted, so holders from a
   * previous coordinator can reassert their keys first. Zero for a coordinator
   * that never replaces another.
   */
  graceWindow?: number;
}

interface Reassertion {
  token: FencingToken;
  lease: Promise<Lease>;
  lose(): void;
}

interface CoordinatorPhase {
  acquire(key: string, options: AcquireOptions): Promise<Lease>;
  tryAcquire(key: string): Promise<Lease | undefined>;
  reassert(
    key: string,
    token: FencingToken,
    lose: () => void,
  ): Promise<Lease> | undefined;
}

/**
 * Grants keys in FIFO order to its own callers and to peers it serves over
 * connections. A peer that disconnects releases everything it held or waited for.
 */
export class LockCoordinator implements LockStore {
  #phase: CoordinatorPhase;

  constructor({ tokens, graceWindow = 0 }: LockCoordinatorOptions) {
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

  async acquire(key: string, options: AcquireOptions = {}): Promise<Lease> {
    return this.#phase.acquire(key, options);
  }

  /** Nothing is granted during the grace window, so a key counts as busy then. */
  async tryAcquire(key: string): Promise<Lease | undefined> {
    return this.#phase.tryAcquire(key);
  }

  serve(connection: Connection<LockResponse, LockRequest>): void {
    new Session(this, connection);
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
  ): Promise<Lease> | undefined {
    return this.#phase.reassert(key, token, lose);
  }
}

/** The only phase that grants. A holder that reasserts now is too late. */
class Granting implements CoordinatorPhase {
  readonly #store: MemoryStore;

  constructor(store: MemoryStore) {
    this.#store = store;
  }

  acquire(key: string, { signal }: AcquireOptions): Promise<Lease> {
    return this.#store.acquire(key, { signal });
  }

  tryAcquire(key: string): Promise<Lease | undefined> {
    return this.#store.tryAcquire(key);
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

  async acquire(key: string, { signal }: AcquireOptions): Promise<Lease> {
    await untilAborted(this.#over.wait(), signal);
    return this.#next.acquire(key, { signal });
  }

  async tryAcquire(): Promise<undefined> {
    return undefined;
  }

  reassert(
    key: string,
    token: FencingToken,
    lose: () => void,
  ): Promise<Lease> | undefined {
    const existing = this.#reassertions.get(key);
    if (existing && !token.isNewerThan(existing.token)) return undefined;

    existing?.lose();
    // Nothing is granted during grace, so the first claim gets the key at once
    // and a newer claim takes over that same lease.
    const lease = existing?.lease ?? this.#store.acquire(key);
    this.#reassertions.set(key, { token, lease, lose });
    return lease;
  }
}

class Session {
  readonly #coordinator: LockCoordinator;
  readonly #requested = new Set<string>();
  readonly #lost = new Set<string>();
  #phase: SessionPhase;

  constructor(
    coordinator: LockCoordinator,
    connection: Connection<LockResponse, LockRequest>,
  ) {
    this.#coordinator = coordinator;
    this.#phase = new Serving(connection);
    connection.listen({
      message: (request) => {
        this.#handle(request).catch(() => connection.close());
      },
      close: () => {
        void this.#end();
      },
    });
  }

  async #handle(request: LockRequest) {
    switch (request.op) {
      case 'acquire': {
        // A reconnecting client may resend a request; granting it twice would orphan one lease.
        if (this.#requested.has(request.id)) return;
        this.#requested.add(request.id);
        const lease = await this.#coordinator.acquire(request.key);
        return this.#grant(lease, request.id);
      }
      case 'try': {
        if (this.#requested.has(request.id)) return;
        this.#requested.add(request.id);
        const lease = await this.#coordinator.tryAcquire(request.key);
        if (!lease) {
          this.#requested.delete(request.id);
          return this.#phase.reply({ op: 'busy', id: request.id });
        }
        return this.#grant(lease, request.id);
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
        const claim = this.#coordinator.reassert(
          request.key,
          new FencingToken(BigInt(request.token)),
          () => this.#lose(request.id),
        );
        if (!claim) {
          return this.#phase.reply({ op: 'rejected', id: request.id });
        }
        const lease = await claim;
        if (this.#lost.has(request.id)) return;
        return this.#phase.keep(lease, request.id);
      }
    }
  }

  /** A request cancelled while the grant was on its way releases the key at once. */
  #grant(lease: Lease, id: string) {
    if (!this.#requested.has(id)) return lease[Symbol.asyncDispose]();
    return this.#phase.grant(lease, id);
  }

  /** A newer claim took this session's reasserted lease over, so it must not release it. */
  #lose(id: string) {
    this.#lost.add(id);
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
  grant(lease: Lease, id: string): Promise<void>;
  keep(lease: Lease, id: string): Promise<void>;
  release(id: string): Promise<void>;
  lose(id: string): void;
  end(): Promise<void>;
}

/** The peer is connected: the session keeps its leases and answers it. */
class Serving implements SessionPhase {
  readonly #connection: Connection<LockResponse, LockRequest>;
  readonly #leases = new Map<string, Lease>();

  constructor(connection: Connection<LockResponse, LockRequest>) {
    this.#connection = connection;
  }

  async reply(response: LockResponse) {
    // A failed send means the peer is gone; `close` then releases its leases.
    await this.#connection.send(response).catch(() => {});
  }

  async grant(lease: Lease, id: string) {
    this.#leases.set(id, lease);
    await this.reply({ op: 'granted', id, token: lease.token.toString() });
  }

  async keep(lease: Lease, id: string) {
    this.#leases.set(id, lease);
  }

  async release(id: string) {
    const lease = this.#leases.get(id);
    this.#leases.delete(id);
    await lease?.[Symbol.asyncDispose]();
  }

  lose(id: string) {
    this.#leases.delete(id);
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

  async grant(lease: Lease) {
    await lease[Symbol.asyncDispose]();
  }

  async keep(lease: Lease) {
    await lease[Symbol.asyncDispose]();
  }

  async release() {}

  lose() {}

  async end() {}
}
