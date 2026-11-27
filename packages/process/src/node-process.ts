import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';

import { Cond, untilAborted } from '@zukhruf/async';

import { ProcessEndedError } from './process-ended-error.ts';
import type {
  PipedProcess,
  Process,
  StartedProcess,
} from './started-process.ts';

/** A value that a Node process and its parent send each other over the IPC channel. */
export interface Message {
  readonly type: string;
  readonly [field: string]: unknown;
}

/** A type, or a function that selects a message. */
export type MessageMatch = string | ((message: Message) => boolean);

/** A started process that runs JavaScript source in its own Node.js, with an IPC channel (ADR 0007). */
export interface NodeProcess extends AsyncDisposable {
  readonly process: PipedProcess;
  /** Each message so far, in order. A value with no string `type` is not a message. */
  readonly messages: readonly Message[];
  /** Sends a message. Throws ERR_IPC_CHANNEL_CLOSED once the channel has closed. */
  send(message: Message): void;
  /**
   * The first message that `match` selects, sent before or after the call. A
   * function sees each message once, in the order sent, so it can count.
   * Rejects with ProcessEndedError when the process ends first, and with the
   * reason of `signal` when it aborts.
   */
  next(
    match: MessageMatch,
    options: { readonly signal: AbortSignal },
  ): Promise<Message>;
  /** Stops the process group, as the disposal of `process` does. */
  [Symbol.asyncDispose](): Promise<void>;
}

function isMessage(value: unknown): value is Message {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
  );
}

/**
 * The IPC channel to a Node.js child. Build it in the tick of the spawn: a
 * message that arrives with no listener is lost.
 */
export class Channel {
  readonly messages: Message[] = [];
  readonly #child: ChildProcess;
  /** Broadcasts at each message and at the close of the channel. */
  readonly #changed = new Cond();

  constructor(child: ChildProcess) {
    this.#child = child;
    child.on('message', (message: unknown) => {
      if (!isMessage(message)) return;
      this.messages.push(message);
      this.#changed.broadcast();
    });
    child.once('disconnect', () => this.#changed.broadcast());
  }

  send(message: Message): void {
    // The trial reports a closed channel only later, as an 'error' event of
    // the child that nobody listens to, so the state predicts it here.
    if (!this.#child.connected)
      throw Object.assign(new Error('Channel closed'), {
        code: 'ERR_IPC_CHANNEL_CLOSED',
      });
    // A channel that closes during the write gives the error to this callback,
    // not to an 'error' event that would crash this process. The message is
    // dropped, and the end of the process reports it.
    this.#child.send(message, () => {});
  }

  /** The first message that `match` selects, or ProcessEndedError (`before` says what was waited for). */
  async next(
    match: MessageMatch,
    process: Process,
    signal: AbortSignal | undefined,
    before: string,
  ): Promise<Message> {
    signal?.throwIfAborted();
    const selects =
      typeof match === 'string'
        ? (message: Message) => message.type === match
        : match;
    for (let index = 0; ; index++) {
      const message =
        this.messages[index] ?? (await this.#arrival(index, signal));
      if (message === undefined) break;
      if (selects(message)) return message;
    }
    throw new ProcessEndedError(
      process.name,
      // The channel can close before the process ends.
      await untilAborted(process.ended, signal),
      process.stderrTail(),
      before,
    );
  }

  /** The message at `index` once it arrives, or undefined when the channel closes first. */
  async #arrival(
    index: number,
    signal: AbortSignal | undefined,
  ): Promise<Message | undefined> {
    while (this.messages.length <= index && this.#child.connected)
      await this.#changed.wait({ signal });
    return this.messages[index];
  }
}

/** The process behind `NodeProcess`. */
export class StartedNodeProcess implements NodeProcess {
  // A class, not PipedProcess: zukhruf/no-promise-field reads the `ended` of
  // an interface as a promise kept in a field.
  readonly process: StartedProcess<Writable>;
  readonly #channel: Channel;

  constructor(process: StartedProcess<Writable>, channel: Channel) {
    this.process = process;
    this.#channel = channel;
  }

  get messages(): readonly Message[] {
    return this.#channel.messages;
  }

  send(message: Message): void {
    this.#channel.send(message);
  }

  next(
    match: MessageMatch,
    { signal }: { readonly signal: AbortSignal },
  ): Promise<Message> {
    return this.#channel.next(
      match,
      this.process,
      signal,
      typeof match === 'string'
        ? `it sent '${match}'`
        : 'it sent a selected message',
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.process[Symbol.asyncDispose]();
  }
}
