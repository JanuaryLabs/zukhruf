import { setTimeout as delay } from 'node:timers/promises';

import { untilAborted } from '@zukhruf/async';
import { FencingToken } from '@zukhruf/fencing';
import { LeaseController } from '@zukhruf/lease';

import type { LockHandle } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { InProcessTurns } from '../../shared/in-process-turns.ts';

/** The events of a session that tell the store that the session ended. */
export interface SessionEvents {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
}

/** The listeners that the store puts on each session that it owns. */
export interface SessionListeners {
  error: (error: Error) => void;
  end: () => void;
}

/** The lock of one key on the server. */
export interface SessionLock {
  key: string;
  /** The name of the lock on the server, made from the key digest. */
  name: string;
}

/** What differs between the servers of the SQL lock stores, and between their drivers. */
export interface SessionLockDialect<Session extends SessionEvents> {
  /** The name of the server in error messages. */
  readonly server: string;
  /** The name of the lock of `key` on the server. */
  lockName(key: string): string;
  /** Waits in the server's queue until the session holds the lock. A cancel of `signal` rejects at once. */
  wait(
    session: Session,
    lock: SessionLock,
    signal: AbortSignal | undefined,
  ): Promise<void>;
  /** Takes the lock only when no other session holds it. */
  try(session: Session, lock: SessionLock): Promise<boolean>;
  /** Gives the next fencing token. */
  mint(session: Session): Promise<bigint>;
  /** Sends a short query that acquires nothing. */
  heartbeat(session: Session): Promise<void>;
  /** Releases the lock; `false` when the session did not hold it. */
  release(session: Session, lock: SessionLock): Promise<boolean>;
  /** Whether any session holds the lock now. It never acquires the lock. */
  isHeld(session: Session, lock: SessionLock): Promise<boolean>;
  /** Takes the store's listeners off a session that goes back to its pool. */
  detach(session: Session, listeners: SessionListeners): void;
  /** Gives back a session that holds nothing: to its pool, or by a close. */
  giveBack(session: Session): void;
  /** Ends the connection: the server then releases each lock of the session. */
  destroy(session: Session): void;
}

export interface SessionLockStoreOptions<Session extends SessionEvents> {
  /** Gives a new session. The store owns each session that it gets. */
  connect(): Promise<Session>;
  /**
   * Milliseconds between two heartbeats of a holder, and the time limit of
   * each heartbeat: the longest time that a holder can work after its session
   * ended, before its signal aborts.
   */
  heartbeatInterval: number;
}

/**
 * Holds a session-level lock of a SQL server for each key, on a session of
 * its own. The server releases the lock when the session ends, so a holder
 * that stops never leaves a key locked. Every process on every machine that
 * reaches one database shares the locks.
 *
 * Callers in this process first line up in a queue in memory, so only the
 * first one gets a session: one session per key per process, however many
 * callers wait, and first-come order within the process.
 */
export class SessionLockStore<
  Session extends SessionEvents,
> implements LockStore {
  readonly #turns = new InProcessTurns();
  readonly #options: SessionLockStoreOptions<Session>;
  readonly #dialect: SessionLockDialect<Session>;

  constructor(
    options: SessionLockStoreOptions<Session>,
    dialect: SessionLockDialect<Session>,
  ) {
    this.#options = options;
    this.#dialect = dialect;
  }

  acquire(key: string, options?: AcquireOptions): Promise<LockHandle> {
    return this.#turns.acquire(key, options, async () => {
      const signal = options?.signal;
      const session = await this.#session(key, signal);
      await session.wait(signal);
      return session.hold();
    });
  }

  tryAcquire(key: string): Promise<LockHandle | undefined> {
    return this.#turns.tryAcquire(key, async () => {
      const session = await this.#session(key, undefined);
      if (!(await session.try())) return undefined;
      return session.hold();
    });
  }

  /** Asks the server on a short session, and never acquires the lock. */
  async isHeld(key: string): Promise<boolean> {
    const dialect = this.#dialect;
    const session = new OwnedSession(await this.#options.connect(), dialect);
    try {
      const held = await dialect.isHeld(session.session, {
        key,
        name: dialect.lockName(key),
      });
      session.giveBack();
      return held;
    } catch (error) {
      session.destroy();
      throw error;
    }
  }

  /** Gets a session for `key`. A cancel never waits for `connect`: a session that comes later is given back at once. */
  async #session(
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<KeySession<Session>> {
    const dialect = this.#dialect;
    const connecting = this.#options.connect();
    try {
      return new KeySession(
        new OwnedSession(await untilAborted(connecting, signal), dialect),
        key,
        this.#options.heartbeatInterval,
        dialect,
      );
    } catch (error) {
      if (signal?.aborted && error === signal.reason) {
        void connecting.then(
          (late) => dialect.giveBack(late),
          () => {},
        );
      }
      throw error;
    }
  }
}

/**
 * A session from `connect` that the store owns until it gives it back or
 * destroys it, once. Its `ended` signal aborts when the session emits `error`
 * or `end`. Its listeners stay on a destroyed session, because a driver can
 * emit `error` after the close.
 */
class OwnedSession<Session extends SessionEvents> {
  readonly session: Session;
  readonly #dialect: SessionLockDialect<Session>;
  readonly #ended = new AbortController();
  readonly #owned = new AbortController();
  readonly #listeners: SessionListeners = {
    error: (error) => this.#ended.abort(error),
    end: () =>
      this.#ended.abort(
        new Error(`The ${this.#dialect.server} session ended.`),
      ),
  };

  constructor(session: Session, dialect: SessionLockDialect<Session>) {
    this.session = session;
    this.#dialect = dialect;
    session.on('error', this.#listeners.error);
    session.on('end', this.#listeners.end);
  }

  get ended(): AbortSignal {
    return this.#ended.signal;
  }

  /** The session holds nothing. */
  giveBack(): void {
    if (this.#owned.signal.aborted) return;
    this.#owned.abort();
    this.#dialect.detach(this.session, this.#listeners);
    this.#dialect.giveBack(this.session);
  }

  /** The lock state of the session is not known: the server releases each lock of a session that ends. */
  destroy(): void {
    if (this.#owned.signal.aborted) return;
    this.#owned.abort();
    this.#dialect.destroy(this.session);
  }
}

/** One session for one key: it waits for the lock or tries it, then holds it with a heartbeat. */
class KeySession<Session extends SessionEvents> {
  readonly #owned: OwnedSession<Session>;
  readonly #lock: SessionLock;
  readonly #heartbeatInterval: number;
  readonly #dialect: SessionLockDialect<Session>;
  readonly #lease: LeaseController;
  /** Aborts when the store stops holding: a release, or a lost session. */
  readonly #done = new AbortController();

  constructor(
    owned: OwnedSession<Session>,
    key: string,
    heartbeatInterval: number,
    dialect: SessionLockDialect<Session>,
  ) {
    this.#owned = owned;
    this.#lock = { key, name: dialect.lockName(key) };
    this.#heartbeatInterval = heartbeatInterval;
    this.#dialect = dialect;
    this.#lease = new LeaseController(key);
  }

  /** Waits in the server's lock queue. A cancel destroys the session, and the end of the session releases a late grant. */
  async wait(signal: AbortSignal | undefined): Promise<void> {
    try {
      await this.#dialect.wait(this.#owned.session, this.#lock, signal);
    } catch (error) {
      this.#owned.destroy();
      throw error;
    }
  }

  async try(): Promise<boolean> {
    try {
      if (await this.#dialect.try(this.#owned.session, this.#lock)) return true;
    } catch (error) {
      this.#owned.destroy();
      throw error;
    }
    this.#owned.giveBack();
    return false;
  }

  /** Mints the token of a granted lock and starts the heartbeat. A failed mint releases the key. */
  async hold(): Promise<LockHandle> {
    let token: FencingToken;
    try {
      token = new FencingToken(await this.#dialect.mint(this.#owned.session));
    } catch (error) {
      await this.#release();
      throw error;
    }
    const ended = this.#owned.ended;
    ended.addEventListener('abort', () => this.#lose(ended.reason), {
      once: true,
      signal: this.#done.signal,
    });
    void this.#beat();
    return {
      token,
      signal: this.#lease.signal,
      [Symbol.asyncDispose]: () => this.#release(),
    };
  }

  /** Sends a heartbeat each interval. A failed or late answer loses the lease. */
  async #beat(): Promise<void> {
    const interval = this.#heartbeatInterval;
    const done = this.#done.signal;
    try {
      for (;;) {
        await delay(interval, undefined, { signal: done });
        await untilAborted(
          this.#dialect.heartbeat(this.#owned.session),
          AbortSignal.any([done, AbortSignal.timeout(interval)]),
        );
      }
    } catch (cause) {
      if (!done.aborted) this.#lose(cause);
    }
  }

  /** Another holder can have the key now. */
  #lose(cause: unknown): void {
    if (this.#done.signal.aborted) return;
    this.#done.abort();
    this.#lease.lose(cause);
    this.#owned.destroy();
  }

  async #release(): Promise<void> {
    if (this.#done.signal.aborted) return;
    this.#done.abort();
    try {
      if (!(await this.#dialect.release(this.#owned.session, this.#lock))) {
        throw new Error(
          `The session did not hold the lock of ${JSON.stringify(this.#lock.key)}.`,
        );
      }
    } catch (cause) {
      // A plain give-back would give the next borrower a lock that this session may still hold.
      this.#lease.lose(cause);
      this.#owned.destroy();
      return;
    }
    this.#lease.end();
    this.#owned.giveBack();
  }
}
