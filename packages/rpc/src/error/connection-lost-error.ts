/**
 * A call that gets no answer, because the connection it went out on is gone:
 * the peer stopped, or this client closed. The peer may have run the call, so
 * the caller decides whether to make it again (StreamJsonRpc's
 * `ConnectionLostException`).
 */
export class ConnectionLostError extends Error {
  constructor(options?: ErrorOptions) {
    super('The connection was lost before the call was answered.', options);
    this.name = 'ConnectionLostError';
  }
}
