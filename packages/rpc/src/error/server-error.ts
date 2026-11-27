/**
 * An error that the peer threw, of a class that this end's `ErrorCodec` does
 * not list. It keeps the peer's `name`, `message`, `stack` and own fields, as
 * Go's `rpc.ServerError` keeps the text of a remote error.
 */
export class ServerError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}
