import { rm } from 'node:fs/promises';
import type { Socket } from 'node:net';

import { Latch } from '@zukhruf/async';
import { PipeAddress } from '@zukhruf/pipes';

/** A listener as a sender reads it from its row. */
export interface Addressed {
  readonly id: string;
  readonly address: string;
}

// The wake: one byte with no content (ADR 0002).
const WAKE = Buffer.of(0);

// The connect errors that mean nobody serves the address any more: a file
// that a killed listener left (ECONNREFUSED), or no file (ENOENT).
const DEAD_CODES = new Set(['ECONNREFUSED', 'ENOENT']);

/**
 * The sender's side: one connection to each listener it woke, the wakes that
 * are due on the next microtask, and the listeners it found dead (ADR 0003,
 * ADR 0004).
 */
export class Wakes {
  readonly #connections = new Map<string, Connection>();
  readonly #dead = new Map<string, string>();
  // The wakes of the transactions of this turn; a microtask is queued while
  // the map is not empty.
  readonly #due = new Map<string, string>();
  readonly #removals = new Set<Latch>();
  readonly #wakeOwn: (id: string) => boolean;
  readonly #fail: (error: unknown) => void;

  /** `wakeOwn` wakes the listener of the sending instance with no socket, and tells whether the id was its own. */
  constructor(
    wakeOwn: (id: string) => boolean,
    fail: (error: unknown) => void,
  ) {
    this.#wakeOwn = wakeOwn;
    this.#fail = fail;
  }

  /** The listeners found dead, whose rows the next transaction removes. */
  dead(): ReadonlyMap<string, string> {
    return new Map(this.#dead);
  }

  /**
   * After a transaction that returned: the removed dead listeners lose their
   * socket files, and each listener read gets one wake on the next microtask.
   */
  sent(
    removed: ReadonlyMap<string, string>,
    listeners: readonly Addressed[],
  ): void {
    for (const [id, address] of removed) {
      this.#dead.delete(id);
      this.#removeFile(address);
    }
    if (listeners.length === 0) return;
    if (this.#due.size === 0) queueMicrotask(() => this.#flush());
    for (const { id, address } of listeners) this.#due.set(id, address);
  }

  /** Writes the wakes that are due, ends the connections, and waits for the removals of socket files. */
  async close(): Promise<void> {
    this.#flush();
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.all(connections.map((connection) => connection.end()));
    await Promise.all([...this.#removals].map((removal) => removal.wait()));
  }

  #flush(): void {
    for (const [id, address] of this.#due) {
      if (this.#dead.has(id) || this.#wakeOwn(id)) continue;
      let connection = this.#connections.get(id);
      if (connection === undefined) {
        connection = new Connection(address, {
          dead: () => {
            this.#connections.delete(id);
            this.#dead.set(id, address);
          },
          lost: (error) => {
            this.#connections.delete(id);
            this.#fail(error);
          },
        });
        this.#connections.set(id, connection);
      }
      connection.wake();
    }
    this.#due.clear();
  }

  // A killed listener's socket file stays (research 20a P1); the sender that
  // removes its row removes the file (research 20e R4, variant B). Windows
  // removes a pipe when its program exits.
  #removeFile(address: string): void {
    if (process.platform === 'win32') return;
    const removal = new Latch();
    this.#removals.add(removal);
    void rm(address, { force: true })
      .catch(this.#fail)
      .finally(() => {
        this.#removals.delete(removal);
        removal.open();
      });
  }
}

interface ConnectionEvents {
  /** The connect was refused, or the listener closed the connection. */
  readonly dead: () => void;
  /** The connect failed for another reason; the next send connects again. */
  readonly lost: (error: unknown) => void;
}

// The connect counts as the wake in flight. A wake while one is in flight is
// owed, and goes out when the first is flushed.
type State =
  | { readonly kind: 'connecting'; owed: boolean; ending: boolean }
  | {
      readonly kind: 'open';
      readonly socket: Socket;
      inFlight: boolean;
      owed: boolean;
    }
  | { readonly kind: 'ended' };

/** One connection to one listener, with at most one wake in flight and at most one owed (research 20e R3). */
class Connection {
  readonly #connected = new Latch();
  #state: State = { kind: 'connecting', owed: true, ending: false };

  constructor(address: string, events: ConnectionEvents) {
    void new PipeAddress(address)
      .connect()
      .then(
        (socket) => this.#opened(socket, events),
        (error: unknown) => {
          if (this.#state.kind === 'ended') return;
          this.#state = { kind: 'ended' };
          if (DEAD_CODES.has(String(Reflect.get(Object(error), 'code'))))
            events.dead();
          else events.lost(error);
        },
      )
      .finally(() => this.#connected.open());
  }

  wake(): void {
    const state = this.#state;
    if (state.kind === 'ended') return;
    if (state.kind === 'connecting' || state.inFlight) {
      state.owed = true;
      return;
    }
    if (state.socket.destroyed) return;
    state.inFlight = true;
    state.socket.write(WAKE, () => this.#flushed());
  }

  /** Ends the connection after the wakes that the system took; drops a wake that a hung listener does not read. */
  async end(): Promise<void> {
    if (this.#state.kind === 'connecting') {
      // The owed wake goes out when the connect succeeds, before the end.
      this.#state.ending = true;
      await this.#connected.wait();
    }
    const state = this.#state;
    this.#state = { kind: 'ended' };
    if (state.kind !== 'open' || state.socket.closed) return;
    const { socket } = state;
    const closed = new Promise((resolve) => socket.once('close', resolve));
    if (socket.writableLength > 0) socket.destroy();
    else socket.end(() => socket.destroy());
    await closed;
  }

  #opened(socket: Socket, events: ConnectionEvents): void {
    if (this.#state.kind !== 'connecting') {
      socket.destroy();
      return;
    }
    // The sender's connections do not keep its program alive.
    socket.unref();
    // Reading lets the listener's close arrive; it sends nothing else.
    socket.resume();
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.#state.kind === 'ended') return;
      this.#state = { kind: 'ended' };
      events.dead();
    });
    const { owed } = this.#state;
    this.#state = { kind: 'open', socket, inFlight: false, owed: false };
    if (owed) this.wake();
  }

  #flushed(): void {
    const state = this.#state;
    if (state.kind !== 'open') return;
    state.inFlight = false;
    if (!state.owed) return;
    state.owed = false;
    this.wake();
  }
}
