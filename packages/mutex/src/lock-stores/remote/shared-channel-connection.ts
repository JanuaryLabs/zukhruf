import { EventEmitter } from 'node:events';

import type { Connection, ConnectionEvents } from './connection.ts';
import { unwrap } from './envelope.ts';

/** The end of a message channel in Node: a worker, a child process, the process itself, or a worker port. */
interface ChannelEnd {
  on(event: string, listener: (envelope: unknown) => void): unknown;
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: (envelope: unknown) => void): unknown;
}

/**
 * A connection over a message channel that the application uses too: an IPC
 * channel or a worker port. Lock messages travel in an envelope, so the
 * application's own messages, which have none, are dropped (ADR 0017). Each
 * subclass decides when it listens, because the listeners can keep the
 * process alive.
 */
export abstract class SharedChannelConnection<Outgoing>
  extends EventEmitter<ConnectionEvents>
  implements Connection<Outgoing>
{
  readonly #channel: ChannelEnd;
  /** The events of the channel that tell that the peer is gone. */
  readonly #goneEvents: readonly string[];

  readonly #onMessage = (envelope: unknown) => {
    const message = unwrap(envelope);
    if (message !== undefined) this.emit('message', message);
  };

  readonly #onGone = () => {
    this.stopListening();
    this.emit('close');
  };

  protected constructor(channel: ChannelEnd, goneEvents: readonly string[]) {
    super();
    this.#channel = channel;
    this.#goneEvents = goneEvents;
  }

  abstract send(message: Outgoing): Promise<void>;

  abstract ref(): void;

  abstract unref(): void;

  abstract close(): void;

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
