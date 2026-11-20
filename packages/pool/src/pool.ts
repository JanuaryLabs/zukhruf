import { hash, randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';

import { Cond, Future, type WallClock, delay } from '@zukhruf/async';
import { PipeEndpoint, type PipeServer } from '@zukhruf/pipes';

import {
  DisposedError,
  type Failure,
  JobCancelledError,
  JobFailedError,
  JobNotFoundError,
} from './errors.ts';
import { Store, warn } from './store.ts';
import {
  type WorkerKind,
  newJobChannel,
  outputChannel,
} from './worker-kind.ts';

// The read of the store that finds an output that no wake told of, at which
// a job that still waits tells the owners of it again (ADR 0018).
const BACKSTOP = 1_000;

/** The job counts of the kind in the store, the same from every host (ADR 0013). */
export interface JobCounts {
  /** Jobs that wait for a worker, also those that wait for a retry. */
  readonly waiting: number;
  /** Jobs that a worker runs. */
  readonly running: number;
}

/** One job in the store: its id, a wait for its output, and its cancel (ADR 0026). */
export interface JobHandle<Output> {
  /** The id of the job in the store. */
  readonly id: string;
  /** Waits for the output. The abort of the signal ends only this wait. */
  result(options?: { signal?: AbortSignal }): Promise<Output>;
  /** A leave for a shared job; a drop or a kill for any other job. */
  cancel(): Promise<void>;
}

/** The wake of a job whose output some results wait for. */
interface Wake {
  readonly cond: Cond;
  waits: number;
  // Counts the outputs told of the job. One that comes while a result reads
  // the store finds no wait on the cond, so each result compares the count
  // from before its read.
  heard: number;
}

/**
 * Sends jobs of one kind to the store, and waits for their outputs (ADR
 * 0013). It holds no worker: the owner of the kind's workers on this
 * computer, a PoolWorkers of any host, runs them. It listens on "an output"
 * before it sends, tells the owners of each job on "a new job", and reads the
 * store at each wake and at the backstop (ADR 0018).
 */
export class Pool<Input, Output> implements AsyncDisposable {
  readonly #kind: WorkerKind<Input, Output>;
  readonly #clock: WallClock;
  readonly #store: Store;
  // Settles when the store has the kind's queue and the pool listens.
  readonly #started: Future<void>;
  readonly #disposed = new AbortController();
  // Settles when the first disposal ended, so every disposal waits for it.
  readonly #closed = new Future<void>();
  readonly #wakes = new Map<string, Wake>();
  // The jobs of the runs that wait: their disposal cancels them (ADR 0013).
  readonly #runs = new Set<string>();
  // The pipe at which the owner connects to the caller of each run, from the
  // construction to the disposal, and the connections it took: a closed one
  // tells the owner that the caller is gone (ADR 0021). A job of an exclusive
  // kind may be shared, and a caller of a shared job that is gone only leaves
  // it, so a Pool of an exclusive kind serves no pipe.
  readonly #callerPipe: Future<PipeServer> | null;
  readonly #owners = new Set<Socket>();

  constructor(options: {
    kind: WorkerKind<Input, Output>;
    /** The path of the store's SQLite file, such as `computerStore(process.env)` (ADR 0015). */
    store: string;
    /** The clock of the backstop: `globalThis` in production. */
    clock: WallClock;
  }) {
    this.#kind = options.kind;
    this.#clock = options.clock;
    this.#store = new Store(options.store, options.clock);
    this.#store.queue.on('error', warn);
    this.#store.notifications.on('error', warn);
    const output = outputChannel(options.kind);
    this.#store.notifications.on('notification', ({ channel, payload }) => {
      if (channel !== output) return;
      const wake = this.#wakes.get(payload);
      if (wake === undefined) return;
      wake.heard++;
      wake.cond.broadcast();
    });
    this.#started = Future.run(async () => {
      await this.#store.start(options.kind);
      await this.#store.notifications.listen(output);
    });
    // The pipe does not keep the program alive.
    this.#callerPipe =
      options.kind.policy === 'standard'
        ? Future.run(async () => {
            const server = await new PipeEndpoint(randomUUID(), {
              prefix: 'zukhruf-pool',
            }).listen((socket) => {
              socket.unref();
              this.#owners.add(socket);
              socket.on('error', warn);
              socket.once('close', () => this.#owners.delete(socket));
            });
            return server.unref();
          })
        : null;
  }

  /** Sends the job, and resolves with its handle once the store has it. A started job has no caller: it runs to its end or its cancel (ADR 0026). */
  start(input: Input): Promise<JobHandle<Output>> {
    return this.#send({ input });
  }

  async #send(envelope: {
    input: Input;
    caller?: string;
  }): Promise<JobHandle<Output>> {
    const { input } = envelope;
    this.#disposed.signal.throwIfAborted();
    await this.#started.wait();
    // Callers that give identical inputs of an exclusive kind share one job
    // (ADR 0014).
    const key = this.#kind.policy === 'exclusive' ? sha256(input) : null;
    let id: string | null = null;
    while (id === null) {
      id =
        (await this.#store.queue.send(
          this.#kind.queue,
          envelope,
          key === null ? {} : { singletonKey: key },
        )) ?? (await this.#shared(key!));
    }
    this.#store.tell(newJobChannel(this.#kind), String(this.#kind.revision));
    return this.handle(id);
  }

  /** The handle of a job of this kind and revision that any host started. It reads nothing. */
  handle(id: string): JobHandle<Output> {
    return {
      id,
      result: (options) => this.#result(id, options?.signal),
      cancel: () => this.#cancel(id),
    };
  }

  /**
   * Starts the job and waits for its output. The abort of the signal cancels
   * the job, and the run rejects with the signal's reason (ADR 0019).
   */
  async run(input: Input, options?: { signal?: AbortSignal }): Promise<Output> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    const pipe = this.#callerPipe;
    const handle = await this.#send(
      pipe === null
        ? { input }
        : { input, caller: (await pipe.wait()).endpoint.address.path },
    );
    this.#runs.add(handle.id);
    try {
      return await handle.result(options);
    } catch (error) {
      if (signal?.aborted && error === signal.reason) {
        try {
          await handle.cancel();
        } catch (failed) {
          throw new SuppressedError(
            failed,
            error,
            'The cancel of an aborted run failed.',
          );
        }
      }
      throw error;
    } finally {
      this.#runs.delete(handle.id);
    }
  }

  /** The job counts of the kind in the store. They lag up to one pass of the store's monitor. */
  async stats(): Promise<JobCounts> {
    await this.#started.wait();
    const [counts] = await this.#store.queue.getQueueStats(this.#kind.queue);
    return { waiting: counts!.queuedCount, running: counts!.activeCount };
  }

  async #result(id: string, signal: AbortSignal | undefined): Promise<Output> {
    const stop =
      signal === undefined
        ? this.#disposed.signal
        : AbortSignal.any([this.#disposed.signal, signal]);
    stop.throwIfAborted();
    await this.#started.wait();
    const wake = this.#wake(id);
    try {
      for (;;) {
        const heard = wake.heard;
        const [job] = await this.#store.queue.findJobs(this.#kind.queue, {
          id,
        });
        if (job === undefined) throw new JobNotFoundError(id);
        if (job.state === 'completed') return outputOf<Output>(job.output);
        if (job.state === 'failed')
          throw new JobFailedError(id, failureOf(job.output));
        if (job.state === 'cancelled') throw new JobCancelledError(id);
        // A job that still waits tells the owners again, so an owner learns
        // of it after a lost wake.
        if (job.state !== 'active')
          this.#store.tell(
            newJobChannel(this.#kind),
            String(this.#kind.revision),
          );
        if (wake.heard === heard) await this.#next(wake, stop);
      }
    } finally {
      if (--wake.waits === 0) this.#wakes.delete(id);
    }
  }

  // The wake of the job, with one more wait on it.
  #wake(id: string): Wake {
    const found = this.#wakes.get(id);
    if (found !== undefined) {
      found.waits++;
      return found;
    }
    const wake = { cond: new Cond(), waits: 1, heard: 0 };
    this.#wakes.set(id, wake);
    return wake;
  }

  // Waits for a wake of the job, or the backstop.
  async #next(wake: Wake, stop: AbortSignal): Promise<void> {
    const done = new AbortController();
    const signal = AbortSignal.any([stop, done.signal]);
    try {
      await Promise.race([
        wake.cond.wait({ signal }),
        delay(BACKSTOP, { clock: this.#clock, signal }),
      ]);
    } finally {
      done.abort();
    }
  }

  // A shared job is a leave: the store does not change, and the job runs for
  // the others. Any other job is cancelled in the store, which drops a job
  // that waits; the owner kills the worker of a running job at its next
  // touch (ADR 0020).
  async #cancel(id: string): Promise<void> {
    this.#disposed.signal.throwIfAborted();
    await this.#started.wait();
    await this.#drop(id);
  }

  async #drop(id: string): Promise<void> {
    if (this.#kind.policy === 'exclusive') return;
    await this.#store.queue.cancel(this.#kind.queue, id);
  }

  // The job of the key that the store keeps, the newest that has not
  // settled, or null when it settled after the send met it.
  async #shared(key: string): Promise<string | null> {
    const jobs = await this.#store.queue.findJobs(this.#kind.queue, { key });
    const [newest] = jobs
      .filter(
        ({ state }) =>
          state === 'created' || state === 'retry' || state === 'active',
      )
      .toSorted((a, b) => b.createdOn.getTime() - a.createdOn.getTime());
    return newest?.id ?? null;
  }

  /**
   * Ends each wait of a result with DisposedError, cancels the jobs of the
   * runs that wait, and closes the store. A disposal that runs again or at
   * the same time waits for the same end.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.#disposed.signal.aborted) {
      // The abort ends the runs, which leave the set, so their ids are read
      // first.
      const runs = [...this.#runs];
      this.#disposed.abort(new DisposedError());
      this.#close(runs).then(
        () => this.#closed.resolve(),
        (error: unknown) => this.#closed.reject(error),
      );
    }
    await this.#closed.wait();
  }

  async #close(runs: readonly string[]): Promise<void> {
    await Promise.allSettled([this.#started.wait()]);
    try {
      for (const id of runs) await this.#drop(id);
    } finally {
      // The owner hears each closed connection as a caller that is gone.
      for (const socket of this.#owners) socket.destroy();
      const [pipe] = await Promise.allSettled([this.#callerPipe?.wait()]);
      if (pipe.status === 'fulfilled') await pipe.value?.close();
      await this.#store[Symbol.asyncDispose]();
    }
  }
}

/** The key of an input: the SHA-256 of its JSON (ADR 0014). */
function sha256(input: unknown): string {
  return hash('sha256', JSON.stringify(input), 'hex');
}

/** The output that the owner completed the job with (ADR 0012). */
function outputOf<Output>(output: object | null): Output {
  if (!isCompletion<Output>(output))
    throw new TypeError('The job completed with no output: no owner ran it.');
  return output.output;
}

// The pool does not check the output itself: a sender and an owner of one
// revision run the same code (ADR 0014).
function isCompletion<Output>(
  output: object | null,
): output is { output: Output } {
  return output !== null && 'output' in output;
}

/**
 * The failure of a job as data: the name and the message that the owner
 * failed it with, or the message of the store's monitor, which fails a job
 * whose time limit or heartbeat ended (pg-boss plans.js:2376, 2384).
 */
function failureOf(output: object | null): Failure {
  if (output !== null && 'name' in output && 'message' in output)
    return { name: String(output.name), message: String(output.message) };
  if (
    output !== null &&
    'value' in output &&
    typeof output.value === 'object' &&
    output.value !== null &&
    'message' in output.value
  )
    return { name: 'Error', message: String(output.value.message) };
  return { name: 'Error', message: JSON.stringify(output) };
}
