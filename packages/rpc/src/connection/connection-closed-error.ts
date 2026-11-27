/** A send that cannot reach the peer, because the connection is closed. The `cause` is the error of the transport. */
export class ConnectionClosedError extends Error {
  constructor(options?: ErrorOptions) {
    super('The connection is closed.', options);
    this.name = 'ConnectionClosedError';
  }
}
