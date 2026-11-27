import { ConnectionClosedError } from '../connection/connection-closed-error.ts';
import type { Connection } from '../connection/connection.ts';
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
 * is ignored. Serving does not keep the process alive: the owner of the
 * connection refs it.
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

  /** Answers the calls that arrive on `connection` until it closes. */
  serve(connection: Connection<RpcMessage>) {
    const onMessage = (message: unknown) => {
      if (!isRpcCall(message)) return;
      if (message.id === undefined) void this.#run(message);
      else void this.#answer(connection, message);
    };
    connection.on('message', onMessage);
    connection.once('close', () => connection.off('message', onMessage));
  }

  async #answer(connection: Connection<RpcMessage>, request: RpcRequest) {
    let response: RpcMessage;
    try {
      response = { id: request.id, result: await this.#invoke(request) };
    } catch (error) {
      response = { id: request.id, error: this.#errors.encode(error) };
    }
    await connection.send(response).catch((error: unknown) => {
      // The caller is gone; nobody waits for the answer.
      if (!(error instanceof ConnectionClosedError)) throw error;
    });
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
