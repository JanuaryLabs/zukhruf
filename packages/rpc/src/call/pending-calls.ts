import type { ConnectionSupervisor } from '../connection/connection-supervisor.ts';

/** What settles the promise of one call; the caller keeps the promise. */
export interface Settler<Answer> {
  resolve(answer: Answer): void;
  reject(reason: unknown): void;
}

/** What happens to a call that went out on a connection that was lost before the answer came. */
export type LostCallPolicy<Answer> =
  /** The call goes again on the next connection: it is safe to repeat (a lock request, a look). */
  | 'resend'
  /**
   * The call leaves the table at the loss, and `atLoss` settles it at once:
   * the peer may have run it, so the caller decides whether to make it again
   * (StreamJsonRpc's `ConnectionLostException`).
   */
  | { atLoss(call: Settler<Answer>): void }
  /**
   * The call waits, unsent, until the next connection opens, and
   * `atReconnect` settles it then: its answer needs a peer, and a reconnect
   * that fails or can never come rejects it as it rejects each call that
   * waits (a lock try, which the next coordinator answers busy).
   */
  | { atReconnect(call: Settler<Answer>): void };

/** A call taken out of the table, to be settled by whoever took it. */
export interface TakenCall<Request, Answer> extends Settler<Answer> {
  readonly request: Request;
  /** Whether the call went out on the open connection, so its peer may answer it or act on it. */
  readonly sent: boolean;
}

/**
 * `queued` waits for a connection, `sent` went out on the open one, and
 * `lost` went out on a lost one and waits for the next one to be settled.
 */
type Delivery<Answer> =
  | { kind: 'queued' }
  | { kind: 'sent' }
  | { kind: 'lost'; atReconnect(call: Settler<Answer>): void };

const queued = { kind: 'queued' } as const;
const sent = { kind: 'sent' } as const;

interface Pending<Request, Answer> {
  request: Request;
  onLost: LostCallPolicy<Answer>;
  delivery: Delivery<Answer>;
  settler: Settler<Answer>;
  /** Keeps the connection ref'd while the call waits for its answer. */
  held: Disposable;
}

/**
 * The calls that wait for an answer over a supervised connection, by id. A
 * call goes out when it is added, or on the next connection when none is
 * open. The owner reports each loss and each new connection, so it can send
 * its own messages first (a reassertion, a marker). A call holds the
 * connection from its add until it is taken, so the process exits only when
 * no call, and no other holder of the connection, waits.
 */
export class PendingCalls<Request, Answer> {
  readonly #link: ConnectionSupervisor<Request>;
  readonly #calls = new Map<string, Pending<Request, Answer>>();

  /** Each call holds `link`, so one owner's last call does not unref the work of another owner of the link. */
  constructor(link: ConnectionSupervisor<Request>) {
    this.#link = link;
  }

  /** Opens the connection and sends `request`, or keeps it for the next connection. One id is one call. */
  add(
    id: string,
    request: Request,
    onLost: LostCallPolicy<Answer>,
  ): Promise<Answer> {
    if (this.#calls.has(id)) {
      throw new RangeError(`A call with the id "${id}" already waits.`);
    }
    const { promise, resolve, reject } = Promise.withResolvers<Answer>();
    const call: Pending<Request, Answer> = {
      request,
      onLost,
      delivery: queued,
      settler: { resolve, reject },
      held: this.#link.hold(),
    };
    this.#calls.set(id, call);
    this.#link.open();
    this.#dispatch(call);
    return promise;
  }

  /** The request of the call that waits under `id`. */
  get(id: string): Request | undefined {
    return this.#calls.get(id)?.request;
  }

  /** The request that the call of `id` sends from now on, when it goes again. */
  update(id: string, request: Request) {
    const call = this.#calls.get(id);
    if (call) call.request = request;
  }

  /** Sends the call of `id` again now, or on the next connection when none is open: its answer asked for another try. */
  send(id: string) {
    const call = this.#calls.get(id);
    if (call) this.#dispatch(call);
  }

  /** Removes the call of `id`, so a late answer to it settles nothing. */
  take(id: string): TakenCall<Request, Answer> | undefined {
    const call = this.#calls.get(id);
    if (!call) return undefined;
    this.#calls.delete(id);
    call.held[Symbol.dispose]();
    return {
      ...call.settler,
      request: call.request,
      sent: call.delivery.kind === 'sent',
    };
  }

  /**
   * A new connection is open: in the order of their adds, sends each call that
   * waits for one, and settles each lost call whose policy waits for it.
   */
  resume() {
    for (const [id, call] of this.#calls) {
      if (call.delivery.kind === 'lost') {
        call.delivery.atReconnect(this.take(id)!);
      } else if (call.delivery.kind === 'queued') {
        this.#dispatch(call);
      }
    }
  }

  /** The open connection is lost: each call that went out on it follows its policy. */
  interrupt() {
    for (const [id, call] of this.#calls) {
      if (call.delivery.kind !== 'sent') continue;
      const { onLost } = call;
      if (onLost === 'resend') call.delivery = queued;
      else if ('atLoss' in onLost) onLost.atLoss(this.take(id)!);
      else call.delivery = { kind: 'lost', atReconnect: onLost.atReconnect };
    }
  }

  rejectAll(reason: (request: Request) => unknown) {
    for (const id of [...this.#calls.keys()]) {
      const call = this.take(id)!;
      call.reject(reason(call.request));
    }
  }

  #dispatch(call: Pending<Request, Answer>) {
    call.delivery = this.#link.send(call.request) ? sent : queued;
  }
}
