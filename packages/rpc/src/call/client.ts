import { untilAborted } from '@zukhruf/async';

import type { ConnectionSupervisor } from '../connection/connection-supervisor.ts';
import { ConnectionLostError } from '../error/connection-lost-error.ts';
import type { ErrorCodec } from '../error/error-codec.ts';
import type { AnswerChecks, Methods } from './methods.ts';
import { type LostCallPolicy, PendingCalls } from './pending-calls.ts';
import {
  type RpcMessage,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
  isRpcResponse,
} from './rpc-message.ts';

export interface ClientOptions<Remote extends Methods<Remote>> {
  /** Rebuilds the errors that the peer's methods throw. */
  errors: ErrorCodec;
  answers: AnswerChecks<Remote>;
}

export interface CallOptions {
  /** Stops the wait: the call rejects with the signal's reason, and a later answer settles nothing. */
  signal?: AbortSignal | undefined;
}

/** The peer may have run a call that was in flight, so the call is not sent again. */
const rejectLost: LostCallPolicy<unknown> = {
  atLoss: (call) => call.reject(new ConnectionLostError()),
};

/**
 * Calls the methods of a peer's `Server` over a supervised connection. A
 * call waits for its answer, or rejects with `ConnectionLostError` as soon as
 * the connection it went out on is lost. A call made while no connection is
 * open goes on the next one. The client holds the connection only while a
 * call or a notification waits, so it keeps the process alive no longer.
 */
export class Client<Remote extends Methods<Remote>> implements AsyncDisposable {
  readonly #link: ConnectionSupervisor<RpcMessage>;
  readonly #errors: ErrorCodec;
  readonly #answers: AnswerChecks<Remote>;
  readonly #calls: PendingCalls<RpcMessage, unknown>;
  /** The notifications made while no connection was open, each with the hold that keeps the process alive until it goes. */
  #outbox: { notification: RpcNotification; held: Disposable }[] = [];
  #nextId = 0;

  constructor(
    link: ConnectionSupervisor<RpcMessage>,
    { errors, answers }: ClientOptions<Remote>,
  ) {
    this.#link = link;
    this.#errors = errors;
    this.#answers = answers;
    this.#calls = new PendingCalls(link);
    link.on('connected', () => {
      this.#flush();
      this.#calls.resume();
    });
    link.on('message', (message) => {
      if (isRpcResponse(message)) this.#receive(message);
    });
    link.on('disconnected', () => this.#calls.interrupt());
    link.on('unavailable', () => this.#fail(new ConnectionLostError()));
    link.on('failed', (error) => this.#fail(error));
  }

  async call<M extends keyof Remote & string>(
    method: M,
    params: Parameters<Remote[M]>,
    { signal }: CallOptions = {},
  ): Promise<Awaited<ReturnType<Remote[M]>>> {
    signal?.throwIfAborted();
    this.#assertOpen();
    const id = String(this.#nextId++);
    const request: RpcRequest = { id, method, params };
    const answer = this.#calls.add(id, request, rejectLost);
    let value: unknown;
    try {
      value = await untilAborted(answer, signal);
    } catch (error) {
      if (signal?.aborted) this.#calls.take(id);
      throw error;
    }
    if (!this.#answers[method](value)) {
      throw new TypeError(
        `The peer answered "${method}" with a value that its check refused.`,
      );
    }
    return value;
  }

  /**
   * Runs `method` on the peer and waits for no answer. It goes on the open
   * connection, or on the next one. A notification that went out is never
   * sent again, and what its method throws stays with the peer.
   */
  notify<M extends keyof Remote & string>(
    method: M,
    params: Parameters<Remote[M]>,
  ) {
    this.#assertOpen();
    const notification: RpcNotification = { method, params };
    this.#link.open();
    if (this.#outbox.length === 0 && this.#link.send(notification)) return;
    this.#outbox.push({ notification, held: this.#link.hold() });
  }

  /** Closes the connection. Each call that waits rejects with `ConnectionLostError`. */
  async [Symbol.asyncDispose]() {
    const closing = this.#link.close();
    this.#fail(new ConnectionLostError());
    await closing;
  }

  #assertOpen() {
    const { status } = this.#link;
    if (status === 'closed' || status === 'unavailable') {
      throw new ConnectionLostError();
    }
  }

  #receive(response: RpcResponse) {
    const call = this.#calls.take(response.id);
    if (!call) return;
    if ('error' in response) call.reject(this.#errors.decode(response.error));
    else call.resolve(response.result);
  }

  /** Sends what waited for this connection, in order, until a send does not reach it. */
  #flush() {
    while (this.#outbox.length > 0) {
      const next = this.#outbox[0]!;
      if (!this.#link.send(next.notification)) return;
      this.#outbox.shift();
      next.held[Symbol.dispose]();
    }
  }

  #fail(reason: unknown) {
    for (const { held } of this.#outbox) held[Symbol.dispose]();
    this.#outbox = [];
    this.#calls.rejectAll(() => reason);
  }
}
