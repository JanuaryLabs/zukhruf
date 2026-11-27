import { EventEmitter } from 'node:events';

import type { Connection, ConnectionEvents } from '../connection/connection.ts';
import { type ChannelOptions, Envelope } from './envelope.ts';

/** The end of a message channel in Node: a worker, a child process, the process itself, or a worker port. */
interface ChannelEnd {
  on(event: string, listener: (envelope: unknown) => void): unknown;
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: (envelope: unknown) => void): unknown;
}

/**
 * A connection over a message channel that the application uses too: an IPC
 * channel or a worker port. The messages of the connection travel in the
 * envelope of its tag, so the application's own messages, which have none,
 * are dropped (mutex ADR 0017). Each subclass decides when it listens,
 * because the listeners can keep the process alive.
 */
export abstract class SharedChannelConnection<Outgoing>
  extends EventEmitter<ConnectionEvents>
  implements Connection<Outgoing>
{
  protected readonly envelope: Envelope;
  readonly #channel: ChannelEnd;
  /** The events of the channel that tell that the peer is gone. */
  readonly #goneEvents: readonly string[];

  readonly #onMessage = (envelope: unknown) => {
    const message = this.envelope.unwrap(envelope);
    if (message !== undefined) this.emit('message', message);
  };

  readonly #onGone = () => {
    this.stopListening();
    this.emit('close');
  };

  protected constructor(
    channel: ChannelEnd,
    goneEvents: readonly string[],
    { tag }: ChannelOptions,
  ) {
    super();
    this.#channel = channel;
    this.#goneEvents = goneEvents;
    this.envelope = new Envelope(tag);
  }

  abstract send(message: Outgoing): Promise<void>;

  abstract ref(): void;

  abstract unref(): void;

  abstract close(): Promise<void>;

  protected listen() {
    this.#channel.on('message', this.#onMessage);
    for (const event of this.#goneEvents) {
      this.#channel.once(event, this.#onGone);
    }
  }

  protected stopListening() {
    this.#channel.off('message', this.#onMessage);
    for (const event of this.#goneEvents) {
      this.#channel.off(event, this.#onGone);
    }
  }
}
