import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { type Clock, delay } from '@zukhruf/async';
import { PipeEndpoint, type PipeServer } from '@zukhruf/pipes';
import { UnchangedJournal, open } from '@zukhruf/sqlite-open';
import { transaction } from '@zukhruf/sqlite-transaction';

import { integer, text } from './columns.ts';
import { ListenerPresence } from './listener-presence.ts';
import { HIGHEST_ID } from './schema.ts';

/** One row of the notification queue, as the listener reads it. */
export interface QueuedNotification {
  readonly id: number;
  readonly channel: string;
  readonly payload: string;
  readonly processId: number;
}

export interface ListeningOptions {
  readonly path: string;
  readonly clock: Clock;
  /** Gets each row of a channel that this listener listens on, in id order. */
  readonly deliver: (notification: QueuedNotification) => void;
  /** Gets a failure that no caller awaits. */
  readonly fail: (error: unknown) => void;
}

// The backstop reads data_version once a second (ADR 0002), and writes the
// position at most as often (ADR 0005).
const BACKSTOP_INTERVAL = 1000;
// SQLite's BUSY (5): another connection holds the write lock past the busy
// timeout. A position write that meets it waits for the next backstop.
const SQLITE_BUSY = 5;

/** The connections that senders made to the listener's socket. Any byte that comes is a wake. */
class Inbox extends EventEmitter<{ wake: [] }> {
  readonly #sockets = new Set<Socket>();

  accept(socket: Socket): void {
    this.#sockets.add(socket);
    socket.on('data', () => this.emit('wake'));
    // A sender that goes away is normal; its close follows.
    socket.on('error', () => {});
    socket.on('close', () => this.#sockets.delete(socket));
  }

  destroy(): void {
    for (const socket of this.#sockets) socket.destroy();
  }
}

/**
 * A listener from its registration to its last unlisten: its presence, its
 * own connection to the file, its socket, its row and the backstop. Each
 * first `listen` makes a new one, with a new listener id and a new socket.
 */
export class Listening {
  /** 16 random bytes in hex: the name of the socket and the key of the row. */
  readonly id: string;
  readonly #database: DatabaseSync;
  readonly #server: PipeServer;
  readonly #inbox: Inbox;
  readonly #presence: ListenerPresence;
  readonly #options: ListeningOptions;
  // Each channel, with the highest id at the commit of its listen: the
  // channel delivers only the rows above it (C3).
  readonly #channels: Map<string, number>;
  // Aborts at the end of the listener: the backstop stops, and reads stop.
  readonly #ended = new AbortController();
  readonly #rows: StatementSync;
  readonly #dataVersion: StatementSync;
  #last: number;
  #position: number;
  #seenVersion: number;

  private constructor(
    id: string,
    database: DatabaseSync,
    server: PipeServer,
    inbox: Inbox,
    presence: ListenerPresence,
    registration: { channel: string; highest: number },
    options: ListeningOptions,
  ) {
    this.id = id;
    this.#database = database;
    this.#server = server;
    this.#inbox = inbox;
    this.#presence = presence;
    this.#options = options;
    this.#channels = new Map([[registration.channel, registration.highest]]);
    this.#last = registration.highest;
    this.#position = registration.highest;
    this.#rows = database.prepare(
      'SELECT id, channel, payload, process_id FROM zukhruf_notify_queue WHERE id > ? ORDER BY id',
    );
    this.#dataVersion = database.prepare('PRAGMA data_version');
    this.#seenVersion = this.#readDataVersion();
    inbox.on('wake', () => this.read());
    void this.#runBackstop(this.#ended.signal).catch(options.fail);
  }

  /**
   * The registration: opens the listener's own connection, takes its
   * presence, serves a new socket, and in one BEGIN IMMEDIATE transaction
   * inserts the listener row with its address and the highest id as its
   * position, and the channel row. The presence comes first, so a sender
   * never finds the row of a live listener without it (ADR 0011).
   */
  static async register(
    channel: string,
    options: ListeningOptions,
  ): Promise<Listening> {
    const id = randomBytes(16).toHex();
    await using registering = new AsyncDisposableStack();
    // The listener never sets the journal: the sending connection did.
    const database = registering.adopt(
      open(options.path, { journal: new UnchangedJournal() }),
      (opened) => opened.close(),
    );
    const presence = registering.adopt(
      await ListenerPresence.take(options.path, id, options.clock),
      (taken) => taken.end(),
    );
    const endpoint = new PipeEndpoint(id, { prefix: 'zukhruf-sqlite-notify' });
    const inbox = new Inbox();
    const server = registering.adopt(
      await endpoint.listen((socket) => inbox.accept(socket)),
      (served) => closeSocket(served, inbox),
    );
    const highest = transaction(
      database,
      () => {
        const highest = highestId(database);
        database
          .prepare(
            'INSERT INTO zukhruf_notify_listener (id, address, position, process_id) VALUES (?, ?, ?, ?)',
          )
          .run(id, endpoint.address.path, highest, process.pid);
        insertChannel(database, channel, id);
        return highest;
      },
      { mode: 'immediate' },
    );
    registering.move();
    return new Listening(
      id,
      database,
      server,
      inbox,
      presence,
      { channel, highest },
      options,
    );
  }

  /** A later listen: one BEGIN IMMEDIATE transaction inserts the channel row and reads the highest id. */
  add(channel: string): void {
    if (this.#channels.has(channel)) return;
    const highest = transaction(
      this.#database,
      () => {
        insertChannel(this.#database, channel, this.id);
        return highestId(this.#database);
      },
      { mode: 'immediate' },
    );
    this.#channels.set(channel, highest);
  }

  /** Removes the channel row; the last one ends the listener. Resolves `true` when the listener ended. */
  async remove(channel: string): Promise<boolean> {
    if (!this.#channels.has(channel)) return false;
    if (this.#channels.size === 1) {
      await this.end();
      return true;
    }
    this.#channels.delete(channel);
    this.#database
      .prepare(
        'DELETE FROM zukhruf_notify_channel WHERE channel = ? AND listener = ?',
      )
      .run(channel, this.id);
    return false;
  }

  /** Removes this listener's rows, closes its socket and its connection, and ends its presence last. */
  async end(): Promise<void> {
    if (this.#ended.signal.aborted) return;
    this.#ended.abort();
    this.#channels.clear();
    await using ending = new AsyncDisposableStack();
    ending.defer(() => this.#presence.end());
    ending.defer(() => this.#database.close());
    ending.defer(() => closeSocket(this.#server, this.#inbox));
    transaction(
      this.#database,
      () => {
        this.#database
          .prepare('DELETE FROM zukhruf_notify_channel WHERE listener = ?')
          .run(this.id);
        this.#database
          .prepare('DELETE FROM zukhruf_notify_listener WHERE id = ?')
          .run(this.id);
      },
      { mode: 'immediate' },
    );
  }

  /**
   * Reads the rows above the last id on the listener's own connection,
   * outside a transaction, with one statement read to the end (research 20b
   * T4), and delivers the rows of its channels.
   */
  read(): void {
    if (this.#ended.signal.aborted) return;
    let rows: QueuedNotification[];
    try {
      rows = this.#rows.all(this.#last).map((row) => ({
        id: integer(row, 'id'),
        channel: text(row, 'channel'),
        payload: text(row, 'payload'),
        processId: integer(row, 'process_id'),
      }));
    } catch (error) {
      this.#options.fail(error);
      return;
    }
    for (const row of rows) {
      if (this.#ended.signal.aborted) return;
      this.#last = row.id;
      const since = this.#channels.get(row.channel);
      if (since !== undefined && row.id > since) this.#options.deliver(row);
    }
  }

  async #runBackstop(signal: AbortSignal): Promise<void> {
    for (;;) {
      try {
        await delay(BACKSTOP_INTERVAL, { clock: this.#options.clock, signal });
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      this.#check();
    }
  }

  // The backstop: reads the queue when data_version changed, then writes the
  // position when it moved. A busy file skips the write until the next check.
  #check(): void {
    try {
      const version = this.#readDataVersion();
      if (version !== this.#seenVersion) {
        this.#seenVersion = version;
        this.read();
      }
    } catch (error) {
      this.#options.fail(error);
    }
    if (this.#ended.signal.aborted || this.#last <= this.#position) return;
    try {
      this.#writePosition();
      this.#position = this.#last;
    } catch (error) {
      if (!isBusy(error)) this.#options.fail(error);
    }
  }

  // node:sqlite is synchronous, so a write that waits for the lock stops the
  // event loop of the listener. The busy timeout is a setting of the
  // connection (node:sqlite has none for one statement), so the write runs
  // with a busy timeout of 0: a busy file fails it at once, and the next
  // backstop tries again (ADR 0005).
  #writePosition(): void {
    const timeout = integer(
      this.#database.prepare('PRAGMA busy_timeout').get(),
      'timeout',
    );
    this.#database.exec('PRAGMA busy_timeout = 0');
    try {
      this.#database
        .prepare('UPDATE zukhruf_notify_listener SET position = ? WHERE id = ?')
        .run(this.#last, this.id);
    } finally {
      this.#database.exec(`PRAGMA busy_timeout = ${timeout}`);
    }
  }

  #readDataVersion(): number {
    return integer(this.#dataVersion.get(), 'data_version');
  }
}

function highestId(database: DatabaseSync): number {
  return integer(database.prepare(`SELECT ${HIGHEST_ID} AS id`).get(), 'id');
}

function insertChannel(
  database: DatabaseSync,
  channel: string,
  listener: string,
): void {
  database
    .prepare(
      'INSERT INTO zukhruf_notify_channel (channel, listener) VALUES (?, ?)',
    )
    .run(channel, listener);
}

// The server stops listening and Node removes the socket file; the
// connections that are open end in the same step (pipes' rule).
async function closeSocket(server: PipeServer, inbox: Inbox): Promise<void> {
  const closed = server.close();
  inbox.destroy();
  await closed;
}

function isBusy(error: unknown): boolean {
  const code = Reflect.get(Object(error), 'errcode');
  return typeof code === 'number' && (code & 0xff) === SQLITE_BUSY;
}
