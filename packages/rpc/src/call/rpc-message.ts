import { type EncodedReason, isEncodedReason } from '../error/error-codec.ts';
import { isRecord } from '../shared/is-record.ts';

/**
 * The messages of a call, with the member names of JSON-RPC 2.0 (sections 4
 * and 5) and without its `jsonrpc` member: the values cross as the channel
 * clones them, not as JSON text.
 */
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export interface RpcRequest {
  id: string;
  method: string;
  params: readonly unknown[];
}

/** A request with no id: nothing answers it. */
export interface RpcNotification {
  id?: undefined;
  method: string;
  params: readonly unknown[];
}

export type RpcResponse =
  { id: string; result: unknown } | { id: string; error: EncodedReason };

/** A received request or notification, checked before the server reads it. */
export function isRpcCall(
  message: unknown,
): message is RpcRequest | RpcNotification {
  return (
    isRecord(message) &&
    typeof message.method === 'string' &&
    Array.isArray(message.params) &&
    (message.id === undefined || typeof message.id === 'string')
  );
}

/** A received response, checked before the client reads it. A JSON line drops a `result` that is `undefined`. */
export function isRpcResponse(message: unknown): message is RpcResponse {
  return (
    isRecord(message) &&
    typeof message.id === 'string' &&
    !Object.hasOwn(message, 'method') &&
    (!Object.hasOwn(message, 'error') || isEncodedReason(message.error))
  );
}
