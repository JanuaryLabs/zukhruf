import { extname } from 'node:path';
import { type ResourceLimits, Worker } from 'node:worker_threads';

import type { Clock, ClockTimer, WorkHandler } from 'pg-boss';

import { Latch } from '@zukhruf/async';
import {
  Client,
  ConnectionLostError,
  ConnectionSupervisor,
  type RpcMessage,
  Server,
  WorkerConnection,
} from '@zukhruf/rpc';

import {
  type CrossingJob,
  type CrossingWip,
  type HostMethods,
  type ThreadMethods,
  errors,
  hostParams,
  pack,
  tag,
  threadAnswers,
} from './protocol.ts';

// The thread's module beside this one: `.ts` when Node runs the source, `.js`
// when it runs the build.
const entry = new URL(
  `./queue-thread${extname(import.meta.filename)}`,
  import.meta.url,
);

/** What one thread reports to the queue that started it. */
export interface ThreadHost {
  readonly clock: Clock;
  /** Whether the engine's timers and time come from `clock`. */
  readonly remote: boolean;
  handlerOf(key: number): WorkHandler<unknown> | undefined;
  error(error: unknown): void;
  warning(warning: Parameters<HostMethods['warning']>[0]): void;
  wip(workers: CrossingWip): void;
  stopped(): void;
  /** The thread ended without being asked to. */
  lost(thread: EngineThread): void;
}

/**
 * One worker thread of the engine, from its spawn to its exit, and the host's
 * end of its link: a `Client` for the engine's methods, and a `Server` of the
 * handlers, the timers and the events. A link carries one thread only, so an
 * answer to a thread that is gone can never reach the one that replaces it.
 */
export class EngineThread {
  readonly #worker: Worker;
  readonly #link: ConnectionSupervisor<RpcMessage>;
  readonly #client: Client<ThreadMethods>;
  readonly #host: ThreadHost;
  /** The timers the thread armed on the host's clock, by the thread's id. */
  readonly #timers = new Map<number, { armed: ClockTimer; repeat: boolean }>();
  /** The controller of each job's signal, by batch and job id. */
  readonly #batches = new Map<number, Map<string, AbortController>>();
  /** How many handlers have settled, so `idle` knows that an answer is on its way to the thread. */
  #settledHandlers = 0;
  #settledAtIdle = 0;
  readonly #exited = new Latch();
  /** Whether the host still talks to the thread, or let it go. */
  #phase: { kind: 'serving' } | { kind: 'ending' } = { kind: 'serving' };

  constructor(host: ThreadHost, resourceLimits: ResourceLimits | undefined) {
    this.#host = host;
    this.#worker = new Worker(
      entry,
      resourceLimits === undefined ? {} : { resourceLimits },
    );
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
    // events.once would reject on the thread's 'error', which comes before its 'exit'.
    this.#worker.once('exit', () => {
      this.#clearTimers();
      // A batch of a lost thread hears no abort: its jobs come back when they expire.
      this.#batches.clear();
      this.#exited.open();
      if (this.#phase.kind === 'serving') host.lost(this);
    });
    this.#worker.on('error', (error) => {
      if (this.#phase.kind === 'serving') host.error(error);
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

  call<M extends keyof ThreadMethods & string>(
    method: M,
    params: Parameters<ThreadMethods[M]>,
  ): Promise<Awaited<ReturnType<ThreadMethods[M]>>> {
    this.#stamp();
    return this.#client.call(method, params);
  }

  /** Nothing goes to a thread that is ending: a timer or a clock may still move meanwhile. */
  notify<M extends keyof ThreadMethods & string>(
    method: M,
    params: Parameters<ThreadMethods[M]>,
  ) {
    if (this.#phase.kind === 'ending') return;
    this.#stamp();
    this.#client.notify(method, params);
  }

  /**
   * Whether the engine had statements to wait for, or a handler settled
   * since the last call: its answer, on its way to the thread, starts the
   * engine's next statements there, as a handler's end starts them on the
   * main thread within the same turn.
   */
  async idle(): Promise<boolean> {
    const waited = await this.call('idle', []);
    const settled = this.#settledHandlers !== this.#settledAtIdle;
    this.#settledAtIdle = this.#settledHandlers;
    return waited || settled;
  }

  /** Sends the host's time before the next message, when the engine runs on the host's clock. */
  stamp() {
    this.#stamp();
  }

  /** Lets the thread exit, and waits until it has. */
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

  /** Stops the thread at once: an attempt that failed. */
  async terminate() {
    if (this.#phase.kind === 'serving') {
      this.#phase = { kind: 'ending' };
      await this.#worker.terminate();
      await this.#link.close();
    }
    await this.#exited.wait();
  }

  #stamp() {
    if (this.#host.remote && this.#phase.kind === 'serving') {
      this.#client.notify('time', [this.#host.clock.now()]);
    }
  }

  #clearTimers() {
    for (const timer of this.#timers.keys()) this.#disarm(timer);
  }

  #disarm(timer: number) {
    const due = this.#timers.get(timer);
    if (!due) return;
    this.#timers.delete(timer);
    if (due.repeat) this.#host.clock.clearInterval(due.armed);
    else this.#host.clock.clearTimeout(due.armed);
  }

  #served(): HostMethods {
    const host = this.#host;
    return {
      handle: async (key: number, batch: number, jobs: CrossingJob[]) => {
        // Each job's controller stays until its signal aborts in the thread,
        // which it does once the batch settles, also after the handler.
        const controllers = new Map<string, AbortController>();
        this.#batches.set(batch, controllers);
        try {
          const handler = host.handlerOf(key);
          if (!handler) {
            throw new Error(`No handler of work ${key} runs on this queue.`);
          }
          const output: unknown = await handler(
            jobs.map((job) => {
              const controller = new AbortController();
              controllers.set(job.id, controller);
              return { ...job, signal: controller.signal };
            }),
          );
          return pack(output);
        } finally {
          this.#settledHandlers++;
          this.#stamp();
        }
      },
      abort: (batch, job, reason) => {
        const controllers = this.#batches.get(batch);
        controllers?.get(job)?.abort(errors.decode(reason));
        controllers?.delete(job);
        if (controllers?.size === 0) this.#batches.delete(batch);
      },
      arm: (timer, ms, repeat) => {
        const fire = () => {
          if (!repeat) this.#timers.delete(timer);
          this.notify('fire', [timer]);
        };
        this.#timers.set(timer, {
          armed: repeat
            ? host.clock.setInterval(fire, ms)
            : host.clock.setTimeout(fire, ms),
          repeat,
        });
      },
      disarm: (timer) => this.#disarm(timer),
      error: (error) => host.error(errors.decode(error)),
      warning: (warning) => host.warning(warning),
      wip: (workers) => host.wip(workers),
      stopped: () => host.stopped(),
      processWarning: (warning) => {
        // The thread's warning goes on as it is, with the code it has.
        const decoded = errors.decode(warning);
        if (isProcessWarning(decoded)) process.emitWarning(decoded);
      },
    };
  }
}

/** A process warning: Node makes an Error of each one, and a package's own warning has a `code`. */
function isProcessWarning(value: unknown): value is Error & { code?: unknown } {
  return Error.isError(value);
}
