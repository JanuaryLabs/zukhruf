import { extname } from 'node:path';
import { Worker } from 'node:worker_threads';

import { type Clock, Latch } from '@zukhruf/async';
import {
  Client,
  ConnectionLostError,
  ConnectionSupervisor,
  type RpcMessage,
  Server,
  WorkerConnection,
} from '@zukhruf/rpc';

import type { Notification } from '../notifications.ts';
import {
  type HostMethods,
  type ThreadMethods,
  errors,
  hostParams,
  tag,
  threadAnswers,
} from './protocol.ts';

// The thread's module beside this one: `.ts` when Node runs the source, `.js`
// when it runs the build.
const entry = new URL(
  `./notify-thread${extname(import.meta.filename)}`,
  import.meta.url,
);

/** How a thread ended: by itself or by the host, or by an error that nothing in it caught. */
export type Exit =
  | { readonly kind: 'ended' }
  | { readonly kind: 'crashed'; readonly error: unknown };

/** What one thread reports to the notifications that started it. */
export interface ThreadHost {
  readonly clock: Clock;
  /** Whether the thread's timers and time come from `clock`. */
  readonly remote: boolean;
  notification(notification: Notification): void;
  error(error: unknown): void;
  /** The thread threw an error that nothing in it caught, and ends. */
  crashed(thread: EngineThread, error: unknown): void;
  /** The thread ended without being asked to. */
  lost(thread: EngineThread): void;
}

/**
 * One worker thread of the notifications, from its spawn to its exit, and
 * the host's end of its link: a `Client` for the thread's methods, and a
 * `Server` of the notifications, the errors and the timers. A link carries
 * one thread only, so a call in flight on a lost thread never goes out again.
 */
export class EngineThread {
  readonly #worker: Worker;
  readonly #link: ConnectionSupervisor<RpcMessage>;
  readonly #client: Client<ThreadMethods>;
  readonly #host: ThreadHost;
  /** The timers the thread armed on the host's clock, by the thread's id. */
  readonly #timers = new Map<number, unknown>();
  readonly #exited = new Latch<Exit>();
  /** Whether the host still talks to the thread, or let it go. */
  #phase: { kind: 'serving' } | { kind: 'ending' } = { kind: 'serving' };

  constructor(host: ThreadHost) {
    this.#host = host;
    this.#worker = new Worker(entry);
    const connection = new WorkerConnection<RpcMessage>(this.#worker, { tag });
    let given = false;
    this.#link = new ConnectionSupervisor<RpcMessage>({
      connect: async () => {
        if (given) return undefined;
        given = true;
        return connection;
      },
    });
    this.#client = new Client<ThreadMethods>(this.#link, {
      errors,
      answers: threadAnswers,
    });
    new Server(this.#served(), { methods: hostParams, errors }).serve(
      this.#link,
    );
    // Node emits the thread's uncaught error before its 'exit', and
    // events.once would reject on it.
    let exit: Exit = { kind: 'ended' };
    this.#worker.on('error', (error) => {
      exit = { kind: 'crashed', error };
      if (this.#phase.kind === 'serving') host.crashed(this, error);
    });
    this.#worker.once('exit', () => {
      this.#clearTimers();
      this.#exited.open(exit);
      if (this.#phase.kind === 'serving') host.lost(this);
    });
    // The link is lost at the thread's exit, and also while the thread runs:
    // @zukhruf/rpc reports a message that the port cannot clone as a loss.
    // Either way the thread is lost now, before a caller can reach it again,
    // and one that still runs is ended, since the host no longer reaches it.
    this.#link.on('disconnected', () => {
      if (this.#phase.kind !== 'serving') return;
      host.lost(this);
      void this.#worker.terminate();
    });
  }

  /** How the thread ended, once it has. */
  exited(): Promise<Exit> {
    return this.#exited.wait();
  }

  call<M extends keyof ThreadMethods & string>(
    method: M,
    params: Parameters<ThreadMethods[M]>,
  ): Promise<Awaited<ReturnType<ThreadMethods[M]>>> {
    this.#stamp();
    return this.#client.call(method, params);
  }

  /** Disposes the thread's notifications, lets the thread exit, and waits until it has. */
  async close() {
    try {
      await this.call('dispose', []);
    } catch (error) {
      // A thread that was lost has nothing left to dispose.
      if (!(error instanceof ConnectionLostError)) throw error;
    } finally {
      await this.end();
    }
  }

  /** Stops the thread at once: an attempt that failed. */
  async terminate() {
    if (this.#phase.kind === 'serving') {
      this.#phase = { kind: 'ending' };
      await this.#worker.terminate();
      await this.#link.close();
    }
    await this.#exited.wait();
  }

  async end() {
    if (this.#phase.kind === 'serving') {
      this.#phase = { kind: 'ending' };
      try {
        this.#client.notify('end', []);
      } catch (error) {
        // A thread that the link no longer reaches cannot hear the word.
        if (!(error instanceof ConnectionLostError)) throw error;
        await this.#worker.terminate();
      }
      await this.#link.close();
    }
    await this.#exited.wait();
  }

  /** Nothing goes to a thread that is ending: a timer may still fire meanwhile. */
  #notify<M extends keyof ThreadMethods & string>(
    method: M,
    params: Parameters<ThreadMethods[M]>,
  ) {
    if (this.#phase.kind === 'ending') return;
    this.#stamp();
    this.#client.notify(method, params);
  }

  #stamp() {
    if (this.#host.remote && this.#phase.kind === 'serving') {
      this.#client.notify('time', [this.#host.clock.performance.now()]);
    }
  }

  #clearTimers() {
    for (const timer of this.#timers.keys()) this.#disarm(timer);
  }

  #disarm(timer: number) {
    if (!this.#timers.has(timer)) return;
    this.#host.clock.clearTimeout(this.#timers.get(timer));
    this.#timers.delete(timer);
  }

  #served(): HostMethods {
    const host = this.#host;
    return {
      notification: (notification) => host.notification(notification),
      error: (error) => host.error(errors.decode(error)),
      arm: (timer, ms) => {
        this.#timers.set(
          timer,
          host.clock.setTimeout(() => {
            this.#timers.delete(timer);
            this.#notify('fire', [timer]);
          }, ms),
        );
      },
      disarm: (timer) => this.#disarm(timer),
    };
  }
}
