import type { ConnectionSupervisor } from '../connection/connection-supervisor.ts';
import type { ErrorCodec } from '../error/error-codec.ts';
import { ServerWarning } from '../error/server-warning.ts';
import type { Methods, ParamChecks } from './methods.ts';
import {
  type RpcMessage,
  type RpcNotification,
  type RpcRequest,
  isRpcCall,
} from './rpc-message.ts';

export interface ServerOptions<Local extends Methods<Local>> {
  /** The methods of `target` that a peer may call, each with the check of its parameters. Any other name, also one that `target` has, is refused. */
  methods: ParamChecks<Local>;
  /** Encodes what a method throws, so the caller gets its class and fields. */
  errors: ErrorCodec;
}

/**
 * Answers the calls that peers make of `target`. It answers each request with
 * the method's value or the error it threw, and runs each notification
 * without an answer. A message that is not a call is not the server's, so it
 * is ignored. Serving holds the connection, so the process stays alive to
 * hear the next call, as a listening `net.Server` does.
 */
export class Server<Local extends Methods<Local>> {
  readonly #target: Local;
  readonly #methods: ReadonlyMap<
    string,
    ((params: readonly unknown[]) => boolean) | undefined
  >;
  readonly #errors: ErrorCodec;

  constructor(target: Local, { methods, errors }: ServerOptions<Local>) {
    this.#target = target;
    this.#methods = new Map(Object.entries(methods));
    this.#errors = errors;
  }

  /**
   * Opens `link` and answers the calls that arrive on it, on the open
   * connection and each one that replaces it. It holds `link` for good, as a
   * listening `net.Server` holds its handle: the hold ends with the link, since
   * a link that is closed or unavailable has no connection left to ref.
   */
  serve(link: ConnectionSupervisor<RpcMessage>) {
    // Never released: a closed or unavailable link refs nothing.
    link.hold();
    link.on('message', (message) => {
      if (!isRpcCall(message)) return;
      if (message.id === undefined) void this.#run(message);
      else void this.#answer(link, message);
    });
    link.open();
  }

  /** A send that does not reach the link drops the answer: the caller is gone, and nobody waits for it. */
  async #answer(link: ConnectionSupervisor<RpcMessage>, request: RpcRequest) {
    let response: RpcMessage;
    try {
      response = { id: request.id, result: await this.#invoke(request) };
    } catch (error) {
      response = { id: request.id, error: this.#errors.encode(error) };
    }
    link.send(response);
  }

  async #run(notification: RpcNotification) {
    try {
      await this.#invoke(notification);
    } catch (error) {
      process.emitWarning(
        new ServerWarning(error, { method: notification.method }),
      );
    }
  }

  async #invoke({
    method,
    params,
  }: Pick<RpcRequest, 'method' | 'params'>): Promise<unknown> {
    const check = this.#methods.get(method);
    const run: unknown = check && Reflect.get(this.#target, method);
    if (!check || typeof run !== 'function') {
      throw new TypeError(`The server has no method "${method}".`);
    }
    if (!check(params)) {
      throw new TypeError(
        `The parameters of "${method}" do not pass the server's check.`,
      );
    }
    return Reflect.apply(run, this.#target, params);
  }
}
