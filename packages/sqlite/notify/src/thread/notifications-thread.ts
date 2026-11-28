import { EventEmitter } from 'node:events';

import { type Clock, Future, delay } from '@zukhruf/async';

import { DisposedError } from '../disposed-error.ts';
import { checkChannel, checkPayload } from '../limits.ts';
import type { FileOptions, Notification } from '../notifications.ts';
import { EngineThread, type ThreadHost } from './engine-thread.ts';
import type { EngineOptions, ThreadMethods } from './protocol.ts';

// pg-boss's reconnect of a lost LISTEN waits 1 s, doubling up to 30 s (db.js:159-178).
const backoff = (failures: number) => Math.min(2 ** failures, 30) * 1000;

/**
 * Where the thread is: an attempt that spawns one and opens the
 * notifications on it (the first, or one that replaces a lost thread), the
 * thread that runs, or a dispose, which every later call finds.
 */
type Phase =
  | { kind: 'attempting'; attempt: Future<EngineThread> }
  | { kind: 'live'; thread: EngineThread }
  | { kind: 'disposed'; ended: Future<void> };

/**
 * Postgres's LISTEN and NOTIFY for one SQLite file, run by `Notifications`
 * in a worker thread. `node:sqlite` is synchronous, so the commits, fsyncs and
 * busy waits of the notifications block that thread and never the host's. A
 * thread that ends outside a dispose is started again and listens again, as
 * pg-boss's LISTEN reconnects (db.js:159-178).
 */
export class NotificationsThread
  extends EventEmitter<{ notification: [Notification]; error: [unknown] }>
  implements AsyncDisposable
{
  readonly #options: EngineOptions;
  readonly #clock: Clock;
  readonly #remote: boolean;
  /** The channels as the calls asked, at once: unlisten stops a channel before the thread hears it, and a new thread listens on each. */
  readonly #wanted = new Set<string>();
  readonly #ended = new AbortController();
  #failures = 0;
  #phase: Phase;

  private constructor(options: Omit<FileOptions, 'database'>) {
    super();
    const { clock, ...engine } = options;
    this.#options = engine;
    this.#clock = clock;
    this.#remote = clock !== globalThis;
    this.#phase = this.#attempt(0, false);
  }

  /**
   * Spawns the thread, which opens the file with `synchronous` FULL. A
   * failure rejects, and leaves no thread.
   */
  static async create(
    options: Omit<FileOptions, 'database'>,
  ): Promise<NotificationsThread> {
    const notifications = new NotificationsThread(options);
    await notifications.#thread();
    return notifications;
  }

  /** Resolves when the registration has committed; each notification that commits after it comes to `notification`. */
  async listen(channel: string): Promise<void> {
    checkChannel(channel);
    this.#assertOpen();
    const had = this.#wanted.has(channel);
    this.#wanted.add(channel);
    try {
      await this.#call('listen', [channel]);
    } catch (error) {
      if (!had) this.#wanted.delete(channel);
      throw error;
    }
  }

  /** Stops the notifications of the channel at once; the last one removes the listener's row and closes its socket. */
  async unlisten(channel: string): Promise<void> {
    checkChannel(channel);
    this.#assertOpen();
    this.#wanted.delete(channel);
    await this.#call('unlisten', [channel]);
  }

  /**
   * Inserts the notification in a BEGIN IMMEDIATE transaction of the thread's
   * connection, and resolves when it has committed. It cannot join a
   * transaction of the caller: no connection crosses a thread.
   */
  async notify(channel: string, payload = ''): Promise<void> {
    checkChannel(channel);
    checkPayload(payload);
    this.#assertOpen();
    await this.#call('notify', [channel, payload]);
  }

  /** Disposes the notifications in the thread, as `Notifications` disposes, and waits for the thread to exit. */
  async [Symbol.asyncDispose](): Promise<void> {
    let phase = this.#phase;
    if (phase.kind !== 'disposed') {
      const ending = phase;
      this.#wanted.clear();
      this.#ended.abort();
      phase = {
        kind: 'disposed',
        ended: Future.run(() => this.#dispose(ending)),
      };
      this.#phase = phase;
    }
    await phase.ended.wait();
  }

  async #dispose(phase: Exclude<Phase, { kind: 'disposed' }>) {
    if (phase.kind === 'live') {
      await phase.thread.close();
      return;
    }
    // An attempt that sees the dispose closes its own thread.
    const [attempt] = await Promise.allSettled([phase.attempt.wait()]);
    if (attempt.status === 'fulfilled') await attempt.value.close();
  }

  /**
   * Sends the call in the caller's turn when the thread runs, so calls reach
   * it in the order they were made. A call made during a restart waits for
   * the attempt, and gets its error when it fails.
   */
  #call<M extends 'listen' | 'unlisten' | 'notify'>(
    method: M,
    params: Parameters<ThreadMethods[M]>,
  ): Promise<void> {
    const phase = this.#phase;
    if (phase.kind === 'live') return phase.thread.call(method, params);
    if (phase.kind === 'disposed') return Promise.reject(new DisposedError());
    return phase.attempt.wait().then((thread) => thread.call(method, params));
  }

  #thread(): Promise<EngineThread> {
    const phase = this.#phase;
    if (phase.kind === 'live') return Promise.resolve(phase.thread);
    if (phase.kind === 'disposed') return Promise.reject(new DisposedError());
    return phase.attempt.wait();
  }

  #assertOpen(): void {
    if (this.#phase.kind === 'disposed') throw new DisposedError();
  }

  /** The first attempt's failure goes to `create`; each failed restart goes to `error`, and the next one waits longer. */
  #attempt(wait: number, restart: boolean): Phase {
    const attempt = Future.run(() => this.#launch(wait));
    void attempt.wait().then(
      (thread) => {
        this.#failures = 0;
        if (this.#phase.kind === 'attempting')
          this.#phase = { kind: 'live', thread };
      },
      (error: unknown) => {
        if (!restart || this.#ended.signal.aborted) return;
        this.#failures++;
        this.#phase = this.#attempt(backoff(this.#failures), true);
        this.#error(error);
      },
    );
    return { kind: 'attempting', attempt };
  }

  /**
   * Waits `wait` ms on the clock, spawns a thread, opens the notifications
   * on it and listens on each channel that the calls want. A thread whose
   * attempt failed or that the dispose overtook does not stay.
   */
  async #launch(wait: number): Promise<EngineThread> {
    const ended = this.#ended.signal;
    if (wait > 0) {
      await delay(wait, { clock: this.#clock, signal: ended }).catch(
        (error: unknown) => {
          if (!ended.aborted) throw error;
        },
      );
    }
    if (ended.aborted) throw new DisposedError();
    const thread = new EngineThread(this.#threadHost());
    try {
      await thread.call('open', [
        this.#options,
        this.#remote ? 'remote' : 'local',
      ]);
      for (const channel of this.#wanted) {
        await thread.call('listen', [channel]);
      }
    } catch (error) {
      await thread.terminate();
      // A thread that crashed loses each call with ConnectionLostError: its
      // own error tells why.
      const exit = await thread.exited();
      throw exit.kind === 'crashed' ? exit.error : error;
    }
    if (ended.aborted) {
      await thread.close();
      throw new DisposedError();
    }
    return thread;
  }

  /** Emits a notification as `Notifications` delivers it: a listener's throw goes to `error`. */
  #deliver(notification: Notification) {
    if (!this.#wanted.has(notification.channel)) return;
    try {
      this.emit('notification', notification);
    } catch (error) {
      this.#error(error);
    }
  }

  /**
   * An `error` that nobody hears, or that a listener throws, ends the host
   * as it ends the main thread's process; the link's server would make it a
   * warning.
   */
  #error(error: unknown) {
    try {
      this.emit('error', error);
    } catch (thrown) {
      process.nextTick(() => {
        throw thrown;
      });
    }
  }

  #threadHost(): ThreadHost {
    return {
      clock: this.#clock,
      remote: this.#remote,
      notification: (notification) => this.#deliver(notification),
      error: (error) => this.#error(error),
      // A crash during an attempt fails the attempt, which reports it once.
      crashed: (thread, error) => {
        const phase = this.#phase;
        if (phase.kind === 'live' && phase.thread === thread)
          this.#error(error);
      },
      lost: (thread) => {
        const phase = this.#phase;
        if (phase.kind !== 'live' || phase.thread !== thread) return;
        this.#phase = this.#attempt(backoff(this.#failures), true);
      },
    };
  }
}
