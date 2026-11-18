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

// ssh2 1.17.0 keeps the callback of a write that waits for window
// (Channel.js:186-194) and calls it only at a window adjust
// (client.js:625-637), so on the close of the channel nothing calls it: the
// write stays in `waiting` until the stream fails it.
function openPhase(channel: Channel, waiting: Set<Callback>): ChannelPhase {
  return {
    write(chunk, callback) {
      waiting.add(callback);
      // At CHANNEL_CLOSE, ssh2 ends the channel before it emits close
      // (onCHANNEL_CLOSE in utils.js). A write after that end fails and
      // destroys the channel, so the check comes first: the write waits for
      // the close.
      if (channel.writableEnded) return;
      channel.write(chunk, (error?: Error | null) => {
        if (waiting.delete(callback)) callback(error);
      });
    },
    end: () => channel.end(),
    close: () => channel.close(),
  };
}

// The server or the connection closed the channel: ssh2 sends nothing more on
// it. A write waits in `waiting` for the stream to fail it.
function closedPhase(waiting: Set<Callback>): ChannelPhase {
  return {
    write: (_chunk, callback) => void waiting.add(callback),
    end() {},
    close() {},
  };
}

// A channel of ssh2 as a Duplex with the semantics of node:stream. ssh2
// 1.17.0's Channel replaces destroy() with end() and close(), emits no error
// and never sets `destroyed` (Channel.js:212), and its _write drops the
// callback of a write on a closed channel (Channel.js:160), so a write would
// wait forever.
export class ChannelStream extends Duplex {
  readonly #channel: Channel;
  readonly #waiting = new Set<Callback>();
  #phase: ChannelPhase;

  /** `lost` gives the error that ended the connection, when it ended the channel. */
  constructor(channel: Channel, lost: () => Error | undefined) {
    super({ allowHalfOpen: true });
    this.#channel = channel;
    this.#phase = openPhase(channel, this.#waiting);
    channel.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) channel.pause();
    });
    // ssh2 emits the close of the connection before it ends and closes its
    // channels (client.js:813-829), so `lost` is known in both listeners.
    const destroyIfLost = (): boolean => {
      const cause = lost();
      if (cause === undefined) return false;
      this.#phase = closedPhase(this.#waiting);
      this.destroy(new Error('ssh: the connection was lost', { cause }));
      return true;
    };
    channel.once('end', () => {
      if (!destroyIfLost()) this.push(null);
    });
    channel.once('close', () => {
      if (destroyIfLost()) return;
      this.#phase = closedPhase(this.#waiting);
      this.push(null);
      // A write that fails destroys the stream, which drops what is left to
      // read, so a write fails as a write to a closed socket does only at the
      // end of the data.
      const close = (): void => {
        for (const callback of this.#waiting) {
          this.#waiting.delete(callback);
          callback(new Error('ssh: the channel is closed'));
        }
        this.destroy();
      };
      if (this.readableEnded) close();
      else this.once('end', close);
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
