import { Latch } from '../../shared/latch.ts';
import type { Connection } from './connection.ts';
import type { Connector } from './connector.ts';

export type SupervisorStatus =
  'idle' | 'connecting' | 'connected' | 'unavailable' | 'closed';

export interface SupervisorHandlers<Incoming> {
  /** A connection is open: the first one, or the replacement for a lost one. */
  connected(): void;
  message(message: Incoming): void;
  /** The open connection is gone and a replacement is on its way. Nothing sent on it will be answered. */
  disconnected(): void;
  /** The connector can never connect again. */
  unavailable(): void;
  /** One attempt to connect failed; the next `open` tries again. */
  failed(error: unknown): void;
}

/**
 * Keeps one connection open at a time. It connects on `open`, replaces a
 * connection that is lost, and stops for good when its connector has no peer
 * left. It never reads the messages it carries: what a replacement must be
 * told again is for its listener to decide.
 */
export class ConnectionSupervisor<Outgoing, Incoming> {
  readonly #supervision: Supervision<Outgoing, Incoming>;

  constructor(connector: Connector<Outgoing, Incoming>) {
    this.#supervision = new Supervision(connector);
  }

  get status(): SupervisorStatus {
    return this.#supervision.state.status;
  }

  listen(handlers: SupervisorHandlers<Incoming>) {
    this.#supervision.handlers = handlers;
  }

  /** Starts connecting, unless a connection is open, on its way, or never coming. */
  open() {
    this.#supervision.state.open();
  }

  /** Whether `message` was handed to an open connection. A failed delivery is reported as a loss. */
  send(message: Outgoing): boolean {
    return this.#supervision.state.send(message);
  }

  /** Keeps the process alive through this connection and every replacement. */
  ref() {
    this.#supervision.reference(true);
  }

  unref() {
    this.#supervision.reference(false);
  }

  /** Closes for good, after any connect still on its way has stopped. */
  close(): Promise<void> {
    return this.#supervision.state.close();
  }
}

interface State<Outgoing> {
  readonly status: SupervisorStatus;
  /** Runs once the state is current, so whatever it starts can check whether it still is. */
  enter(): void;
  open(): void;
  send(message: Outgoing): boolean;
  reference(referenced: boolean): void;
  close(): Promise<void>;
}

const unheard: SupervisorHandlers<unknown> = {
  connected() {},
  message() {},
  disconnected() {},
  unavailable() {},
  failed() {},
};

/** What the states share: the current state, and how to move to the next. */
class Supervision<Outgoing, Incoming> {
  readonly connector: Connector<Outgoing, Incoming>;
  handlers: SupervisorHandlers<Incoming> = unheard;
  referenced = false;
  state: State<Outgoing>;

  constructor(connector: Connector<Outgoing, Incoming>) {
    this.connector = connector;
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

  reference(referenced: boolean) {
    if (this.referenced === referenced) return;
    this.referenced = referenced;
    this.state.reference(referenced);
  }
}

class Idle<Outgoing, Incoming> implements State<Outgoing> {
  readonly status = 'idle';
  readonly #supervision: Supervision<Outgoing, Incoming>;

  constructor(supervision: Supervision<Outgoing, Incoming>) {
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

class Connecting<Outgoing, Incoming> implements State<Outgoing> {
  readonly status = 'connecting';
  readonly #supervision: Supervision<Outgoing, Incoming>;
  readonly #abort = new AbortController();
  /** Opens when the connect ends, so `close` can wait for it. */
  readonly #ended = new Latch();

  constructor(supervision: Supervision<Outgoing, Incoming>) {
    this.#supervision = supervision;
  }

  enter() {
    void this.#connect().finally(() => this.#ended.open());
  }

  async #connect() {
    const supervision = this.#supervision;
    let connection: Connection<Outgoing, Incoming> | undefined;
    try {
      connection = await Promise.try(() =>
        supervision.connector.connect(this.#abort.signal),
      );
    } catch (error) {
      if (!supervision.isCurrent(this)) return;
      supervision.become(new Idle(supervision));
      supervision.handlers.failed(error);
      return;
    }
    if (!supervision.isCurrent(this)) {
      connection?.close();
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

class Connected<Outgoing, Incoming> implements State<Outgoing> {
  readonly status = 'connected';
  readonly #supervision: Supervision<Outgoing, Incoming>;
  readonly #connection: Connection<Outgoing, Incoming>;

  constructor(
    supervision: Supervision<Outgoing, Incoming>,
    connection: Connection<Outgoing, Incoming>,
  ) {
    this.#supervision = supervision;
    this.#connection = connection;
  }

  enter() {
    const supervision = this.#supervision;
    this.#connection.listen({
      message: (message) => {
        if (supervision.isCurrent(this)) supervision.handlers.message(message);
      },
      close: () => this.#lose(),
    });
    this.reference(supervision.referenced);
    supervision.handlers.connected();
  }

  open() {}

  /** The connection may report its loss while it sends, so the state is checked after the call. */
  send(message: Outgoing): boolean {
    this.#connection.send(message).catch(() => this.#lose());
    return this.#supervision.isCurrent(this);
  }

  reference(referenced: boolean) {
    if (referenced) this.#connection.ref();
    else this.#connection.unref();
  }

  async close() {
    this.#supervision.become(new Closed());
    this.#connection.close();
  }

  /** A close event and a failed send can both report one loss; only the first counts. */
  #lose() {
    const supervision = this.#supervision;
    if (!supervision.isCurrent(this)) return;
    this.#connection.close();
    // Leave this state before the listener hears of the loss, so its sends wait for the replacement.
    supervision.become(new Connecting(supervision));
    supervision.handlers.disconnected();
  }
}

class Unavailable<Outgoing, Incoming> implements State<Outgoing> {
  readonly status = 'unavailable';
  readonly #supervision: Supervision<Outgoing, Incoming>;

  constructor(supervision: Supervision<Outgoing, Incoming>) {
    this.#supervision = supervision;
  }

  enter() {
    this.#supervision.handlers.unavailable();
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
