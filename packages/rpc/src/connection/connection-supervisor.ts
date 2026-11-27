import { EventEmitter } from 'node:events';

import { Latch, RefCount, type Referable } from '@zukhruf/async';

import type { Connection } from './connection.ts';
import type { Connector } from './connector.ts';

export type SupervisorStatus =
  'idle' | 'connecting' | 'connected' | 'unavailable' | 'closed';

export interface SupervisorEvents {
  /** A connection is open: the first one, or the replacement for a lost one. */
  connected: [];
  message: [message: unknown];
  /** The open connection is gone and a replacement is on its way. Nothing sent on it will be answered. */
  disconnected: [];
  /** The connector can never connect again. */
  unavailable: [];
  /** One attempt to connect failed; the next `open` tries again. */
  failed: [error: unknown];
}

/**
 * Keeps one connection open at a time. It connects on `open`, replaces a
 * connection that is lost, and stops for good when its connector has no peer
 * left. It never reads the messages it carries: what a replacement must be
 * told again is for its listener to decide.
 */
export class ConnectionSupervisor<
  Outgoing,
> extends EventEmitter<SupervisorEvents> {
  readonly #supervision: Supervision<Outgoing>;

  constructor(connector: Connector<Outgoing>) {
    super();
    this.#supervision = new Supervision(connector, this);
  }

  get status(): SupervisorStatus {
    return this.#supervision.state.status;
  }

  /** Starts connecting, unless a connection is open, on its way, or never coming. */
  open() {
    this.#supervision.state.open();
  }

  /** Whether `message` was handed to an open connection. A failed delivery is reported as a loss. */
  send(message: Outgoing): boolean {
    return this.#supervision.state.send(message);
  }

  /**
   * Keeps the process alive through the open connection, and each one that
   * replaces it, until the token is disposed. The link is ref'd while any
   * token is out, so one holder's release does not unref another's work. A
   * supervisor that nobody holds lets the process exit, as an unref'd socket
   * does.
   */
  hold(): Disposable {
    return this.#supervision.holds.hold();
  }

  /** Closes for good, after any connect still on its way has stopped. */
  close(): Promise<void> {
    return this.#supervision.state.close();
  }
}

/** What a connection is told about the process: keep it alive, or let it exit. */
type Reference = (connection: Referable) => void;

const keepAlive: Reference = (connection) => connection.ref();

const letExit: Reference = (connection) => connection.unref();

interface State<Outgoing> {
  readonly status: SupervisorStatus;
  /** Runs once the state is current, so whatever it starts can check whether it still is. */
  enter(): void;
  open(): void;
  send(message: Outgoing): boolean;
  /** Gives the open connection, if there is one, the supervision's reference. */
  reference(): void;
  close(): Promise<void>;
}

/** What the states share: the current state, the holds on the link, and how to move to the next state. */
class Supervision<Outgoing> {
  readonly connector: Connector<Outgoing>;
  readonly events: EventEmitter<SupervisorEvents>;
  state: State<Outgoing>;
  /** Whether a hold is out. Each new connection takes it on, whatever its adapter starts with. */
  reference: Reference = letExit;
  /** The one count of the link: its first hold refs the link, and the release of its last unrefs it. */
  readonly holds = new RefCount({
    ref: () => this.refer(keepAlive),
    unref: () => this.refer(letExit),
  });

  constructor(
    connector: Connector<Outgoing>,
    events: EventEmitter<SupervisorEvents>,
  ) {
    this.connector = connector;
    this.events = events;
    this.state = new Idle(this);
  }

  /** A state that stopped being current must not act on what it started. */
  isCurrent(state: State<Outgoing>): boolean {
    return this.state === state;
  }

  become(state: State<Outgoing>) {
    this.state = state;
    state.enter();
  }

  refer(reference: Reference) {
    this.reference = reference;
    this.state.reference();
  }
}

class Idle<Outgoing> implements State<Outgoing> {
  readonly status = 'idle';
  readonly #supervision: Supervision<Outgoing>;

  constructor(supervision: Supervision<Outgoing>) {
    this.#supervision = supervision;
  }

  enter() {}

  open() {
    this.#supervision.become(new Connecting(this.#supervision));
  }

  send(): boolean {
    return false;
  }

  reference() {}

  async close() {
    this.#supervision.become(new Closed());
  }
}

class Connecting<Outgoing> implements State<Outgoing> {
  readonly status = 'connecting';
  readonly #supervision: Supervision<Outgoing>;
  readonly #abort = new AbortController();
  /** Opens when the connect ends, so `close` can wait for it. */
  readonly #ended = new Latch();

  constructor(supervision: Supervision<Outgoing>) {
    this.#supervision = supervision;
  }

  enter() {
    void this.#connect().finally(() => this.#ended.open());
  }

  async #connect() {
    const supervision = this.#supervision;
    let connection: Connection<Outgoing> | undefined;
    try {
      connection = await Promise.try(() =>
        supervision.connector.connect(this.#abort.signal),
      );
    } catch (error) {
      if (!supervision.isCurrent(this)) return;
      supervision.become(new Idle(supervision));
      supervision.events.emit('failed', error);
      return;
    }
    if (!supervision.isCurrent(this)) {
      void connection?.close();
      return;
    }
    supervision.become(
      connection
        ? new Connected(supervision, connection)
        : new Unavailable(supervision),
    );
  }

  open() {}

  send(): boolean {
    return false;
  }

  reference() {}

  async close() {
    this.#supervision.become(new Closed());
    this.#abort.abort();
    await this.#ended.wait();
  }
}

class Connected<Outgoing> implements State<Outgoing> {
  readonly status = 'connected';
  readonly #supervision: Supervision<Outgoing>;
  readonly #connection: Connection<Outgoing>;

  constructor(
    supervision: Supervision<Outgoing>,
    connection: Connection<Outgoing>,
  ) {
    this.#supervision = supervision;
    this.#connection = connection;
  }

  enter() {
    const supervision = this.#supervision;
    this.#connection.on('message', (message) => {
      if (supervision.isCurrent(this))
        supervision.events.emit('message', message);
    });
    this.#connection.once('close', () => this.#lose());
    this.reference();
    supervision.events.emit('connected');
  }

  open() {}

  /** The connection may report its loss while it sends, so the state is checked after the call. */
  send(message: Outgoing): boolean {
    this.#connection.send(message).catch(() => this.#lose());
    return this.#supervision.isCurrent(this);
  }

  reference() {
    this.#supervision.reference(this.#connection);
  }

  async close() {
    this.#supervision.become(new Closed());
    await this.#connection.close();
  }

  /** A close event and a failed send can both report one loss; only the first counts. */
  #lose() {
    const supervision = this.#supervision;
    if (!supervision.isCurrent(this)) return;
    void this.#connection.close();
    // Leave this state before the listener hears of the loss, so its sends wait for the replacement.
    supervision.become(new Connecting(supervision));
    supervision.events.emit('disconnected');
  }
}

class Unavailable<Outgoing> implements State<Outgoing> {
  readonly status = 'unavailable';
  readonly #supervision: Supervision<Outgoing>;

  constructor(supervision: Supervision<Outgoing>) {
    this.#supervision = supervision;
  }

  enter() {
    this.#supervision.events.emit('unavailable');
  }

  open() {}

  send(): boolean {
    return false;
  }

  reference() {}

  async close() {
    this.#supervision.become(new Closed());
  }
}

class Closed<Outgoing> implements State<Outgoing> {
  readonly status = 'closed';

  enter() {}

  open() {}

  send(): boolean {
    return false;
  }

  reference() {}

  async close() {}
}
