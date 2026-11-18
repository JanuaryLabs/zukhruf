/**
 * Every use of the internals of ssh2 1.17.0 for the keepalive request of the
 * client. ssh2 is pinned exactly; re-check each line below on a version bump.
 *
 * Why: the keepalive runs on the clock of the config (root ADR 0004), with
 * OpenSSH's ServerAliveInterval semantics (src/server-alive-check.ts), so the
 * package leaves ssh2's keepalive off (no keepaliveInterval) and sends the
 * request itself. ssh2 sends it only from its own keepalive timer.
 *
 * - lib/protocol/Protocol.js:87-95, :343-353: `_protocol.ping()` sends
 *   SSH_MSG_GLOBAL_REQUEST keepalive@openssh.com with want reply.
 * - lib/client.js:501-508: REQUEST_SUCCESS and REQUEST_FAILURE call the first
 *   callback of `callbacks`, the queue of the global requests of the client in
 *   the order they went out. `callbacks` is `_callbacks` (:248) until the
 *   socket closes (:823), which calls each one left with an Error.
 * - lib/client.js:716-734: sendKA pushes a callback onto `callbacks` just
 *   before `proto.ping()`, to keep that order.
 */
import type ssh2 from 'ssh2';

declare module 'ssh2' {
  interface Client {
    readonly _callbacks: (() => void)[];
    readonly _protocol: ClientProtocol;
  }
  interface ClientProtocol {
    ping(): void;
  }
}

/** Sends keepalive@openssh.com with want reply. Its answer goes to no one, as OpenSSH's empty placeholder (clientloop.c:server_alive_check of 10.0p1): the arrival of any data counts. */
export function sendKeepaliveRequest(connection: ssh2.Client): void {
  connection._callbacks.push(() => undefined);
  connection._protocol.ping();
}
