import { isRecord } from '../shared/is-record.ts';

/** How a channel that the application uses too tells its own messages apart. */
export interface ChannelOptions {
  /**
   * The key of the envelope that each message of this connection travels in:
   * `{ [tag]: message }`. A message in no envelope, or in another tag's, is
   * the application's or another protocol's, and the connection drops it.
   */
  tag: string;
}

/** The envelope of one tag. */
export class Envelope {
  readonly #tag: string;

  constructor(tag: string) {
    this.#tag = tag;
  }

  wrap(message: unknown): Record<string, unknown> {
    return { [this.#tag]: message };
  }

  /** The message inside this tag's envelope, unchecked; `undefined` for any other value. */
  unwrap(envelope: unknown): unknown {
    return isRecord(envelope) && Object.hasOwn(envelope, this.#tag)
      ? envelope[this.#tag]
      : undefined;
  }
}
