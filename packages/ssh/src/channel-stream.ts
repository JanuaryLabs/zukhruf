import { Duplex } from 'node:stream';

// The channel of the protocol library, by the members that the stream uses,
// so that no declaration file names a type of that library.
type Channel = Duplex & { close(): void };

type Callback = (error?: Error | null) => void;

/** What the stream can still do with its channel. */
interface ChannelPhase {
  write(chunk: Buffer, callback: Callback): void;
  end(): void;
  close(): void;
}

function openPhase(channel: Channel): ChannelPhase {
  return {
    write: (chunk, callback) => channel.write(chunk, callback),
    end: () => channel.end(),
    close: () => channel.close(),
  };
}

// The server or the connection closed the channel: ssh2 sends nothing more on
// it, and a write fails as a write to a closed socket does.
const closedPhase: ChannelPhase = {
  write: (_chunk, callback) =>
    callback(new Error('ssh: the channel is closed')),
  end() {},
  close() {},
};

// A channel of ssh2 as a Duplex with the semantics of node:stream. ssh2
// 1.17.0's Channel replaces destroy() with end() and close(), emits no error
// and never sets `destroyed` (Channel.js:212), and its _write drops the
// callback of a write on a closed channel (Channel.js:160), so a write would
// wait forever.
export class ChannelStream extends Duplex {
  readonly #channel: Channel;
  #phase: ChannelPhase;

  /** `lost` gives the error that ended the connection, when it ended the channel. */
  constructor(channel: Channel, lost: () => Error | undefined) {
    super({ allowHalfOpen: true });
    this.#channel = channel;
    this.#phase = openPhase(channel);
    channel.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) channel.pause();
    });
    // ssh2 emits the close of the connection before it ends and closes its
    // channels (client.js:813-829), so `lost` is known in both listeners.
    const destroyIfLost = (): boolean => {
      const cause = lost();
      if (cause === undefined) return false;
      this.#phase = closedPhase;
      this.destroy(new Error('ssh: the connection was lost', { cause }));
      return true;
    };
    channel.once('end', () => {
      if (!destroyIfLost()) this.push(null);
    });
    channel.once('close', () => {
      if (destroyIfLost()) return;
      this.#phase = closedPhase;
      this.push(null);
      if (this.readableEnded) this.destroy();
      else this.once('end', () => this.destroy());
    });
  }

  override _read(): void {
    this.#channel.resume();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: Callback,
  ): void {
    this.#phase.write(chunk, callback);
  }

  override _final(callback: Callback): void {
    this.#phase.end();
    callback();
  }

  override _destroy(error: Error | null, callback: Callback): void {
    this.#phase.close();
    callback(error);
  }
}
