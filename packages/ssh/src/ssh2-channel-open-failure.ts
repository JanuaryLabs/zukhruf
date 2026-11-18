/**
 * Every use of the internals of ssh2 1.17.0 for a channel open that the
 * server refused. ssh2 is pinned exactly; re-check each line below on a
 * version bump.
 *
 * Why: @types/ssh2 types the error of a channel open as a plain Error, and
 * ssh2 documents no field for the reason code of SSH_MSG_CHANNEL_OPEN_FAILURE
 * (RFC 4254 §5.1). OpenChannelError gives that code.
 *
 * - lib/protocol/handlers.misc.js:855-881: SSH_MSG_CHANNEL_OPEN_FAILURE is
 *   parsed into the recipient, the reason code (uint32) and the description.
 * - lib/client.js:564-571: the client hands `{ reason, description }` to
 *   onChannelOpenFailure, for each open of the client (openChannel, :1643-1682:
 *   session, direct-tcpip and direct-streamlocal@openssh.com).
 * - lib/utils.js:7-26: onChannelOpenFailure calls back with an Error whose
 *   message is `(SSH) Channel open failure: ${description}` and whose `reason`
 *   is the code. A CHANNEL_CLOSE in place of the answer (:28-34) gives the
 *   message `... server closed channel unexpectedly` and a `reason` of ''. The
 *   loss of the connection gives an Error with no `reason`.
 */

/** The reason code and the description of SSH_MSG_CHANNEL_OPEN_FAILURE, or undefined when the error of the open is not that message. */
export function channelOpenFailure(
  error: Error,
): { readonly code: number; readonly description: string } | undefined {
  if (!('reason' in error) || typeof error.reason !== 'number') {
    return undefined;
  }
  return {
    code: error.reason,
    description: error.message.replace(/^\(SSH\) Channel open failure: /, ''),
  };
}

/** True when the server closed the channel in place of an answer to its open. */
export function closedBeforeOpen(error: Error): boolean {
  return 'reason' in error && error.reason === '';
}
