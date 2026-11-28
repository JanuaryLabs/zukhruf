import { AssertionError } from 'node:assert';
import { EventEmitter } from 'node:events';
import type { ResourceLimits } from 'node:worker_threads';

import {
  type Clock,
  type CommandResponse,
  type CompleteOptions,
  type FetchOptions,
  type FindJobsOptions,
  type Job,
  type JobAttempt,
  type JobWithMetadata,
  type ListOptions,
  type OffWorkOptions,
  type PgBossEventMap,
  type Queue,
  type QueueStats,
  type QueueStatsOptions,
  type Request,
  type ScheduleOptions,
  type SendOptions,
  type StopOptions,
  type UpdateQueueOptions,
  type WipData,
  type WorkHandler,
  type WorkOptions,
  systemClock,
} from 'pg-boss';

import { Future } from '@zukhruf/async';
import { ConnectionLostError } from '@zukhruf/rpc';

import { Activity } from '../activity.ts';
import { Attorney } from '../attorney.ts';
import type { SqliteJobQueueOptions } from '../index.ts';
import type {
  FoundJob,
  JobQueue,
  ListedQueue,
  StartOptions,
} from '../job-queue.ts';
import { Timers } from '../timers.ts';
import { EngineThread, type ThreadHost } from './engine-thread.ts';
import {
  type CrossingWip,
  type EngineOptions,
  type QueueMethod,
  errors,
  pack,
  queueAnswers,
} from './protocol.ts';

export interface SqliteJobQueueThreadOptions extends Omit<
  SqliteJobQueueOptions,
  'database' | 'path'
> {
  /** The queue file, which the thread opens with `synchronous` FULL. */
  path: string;
  /** The limits of the thread's heap and stack (`new Worker`). */
  resourceLimits?: ResourceLimits;
}

/** One `work()` call, which a restart registers again on the new thread. */
interface Work {
  readonly name: string;
  readonly options: WorkOptions | undefined;
  readonly handler: WorkHandler<unknown>;
  /** The id `work()` gave its caller: the id of the first thread's work. */
  id: string;
  /** The id of the work on the thread that runs now. */
  threadId: string;
}

// db.js:112 (12.37.0), as the engine refuses a call before start().
const notOpened = () =>
  new AssertionError({
    message:
      'Database not opened. Call start() before using pg-boss, or again after stop().',
  });

// pg-boss's reconnect waits 1 s, doubling up to 30 s (db.js:159-178).
const backoff = (failures: number) => Math.min(2 ** failures, 30) * 1000;

const unattached: AsyncDisposable = { async [Symbol.asyncDispose]() {} };

/**
 * Where the session's thread is: an attempt that spawns one and opens the
 * engine on it (the first, or one that replaces a lost thread), or the thread
 * that runs.
 */
type ThreadPhase =
  | { kind: 'attempting'; attempt: Future<EngineThread>; restart: boolean }
  | { kind: 'live'; thread: EngineThread };

/** Whether the engine of a session runs, and with which options of start(). */
type EnginePhase =
  { kind: 'unstarted' } | { kind: 'started'; options: StartOptions };

/**
 * The threads of one engine: one at a time, each replaced when it is lost,
 * from the first call that needs the engine to the stop that closes it, and
 * the host's clock attached to them.
 */
class Session {
  readonly ended = new AbortController();
  engine: EnginePhase = { kind: 'unstarted' };
  #phase: ThreadPhase;
  #failures = 0;
  #attachment = unattached;
  readonly #launch: (session: Session, wait: number) => Promise<EngineThread>;
  readonly #failed: (error: unknown) => void;

  /**
   * `launch` spawns a thread after `wait` ms of the clock and opens the
   * engine on it. `failed` hears each restart that failed; the first
   * attempt's failure goes to the call that waits for it.
   */
  constructor(
    launch: (session: Session, wait: number) => Promise<EngineThread>,
    failed: (error: unknown) => void,
  ) {
    this.#launch = launch;
    this.#failed = failed;
    this.#phase = this.#attempt(0, false);
  }

  /** The thread that runs, after the attempt in flight, if one is. Rejects with that attempt's error. */
  thread(): Promise<EngineThread> {
    const phase = this.#phase;
    return phase.kind === 'live'
      ? Promise.resolve(phase.thread)
      : phase.attempt.wait();
  }

  get live(): EngineThread | undefined {
    return this.#phase.kind === 'live' ? this.#phase.thread : undefined;
  }

  /** Whether a lost thread is being replaced. */
  get restarting(): boolean {
    return this.#phase.kind === 'attempting' && this.#phase.restart;
  }

  /** Attaches the host's clock once for the session: a start after a stop keeps it. */
  async attachOnce(attach: () => Promise<AsyncDisposable>) {
    if (this.#attachment === unattached) this.#attachment = await attach();
  }

  /** The thread that runs was lost outside a stop: a new one replaces it after the backoff. */
  lost(thread: EngineThread) {
    if (this.live !== thread || this.ended.signal.aborted) return;
    this.#phase = this.#attempt(backoff(this.#failures), true);
  }

  /** Stops any attempt, and lets the thread exit. */
  async end() {
    this.ended.abort();
    await this.#attachment[Symbol.asyncDispose]();
    // A failed attempt already reached its caller or 'error'.
    const [attempt] = await Promise.allSettled([this.thread()]);
    if (attempt.status === 'fulfilled') await attempt.value.end();
  }

  #attempt(wait: number, restart: boolean): ThreadPhase {
    const attempt = Future.run(() => this.#launch(this, wait));
    void attempt.wait().then(
      (thread) => {
        this.#failures = 0;
        if (this.ended.signal.aborted) return;
        this.#phase = { kind: 'live', thread };
      },
      (error: unknown) => {
        if (!restart || this.ended.signal.aborted) return;
        this.#failures++;
        this.#phase = this.#attempt(backoff(this.#failures), true);
        this.#failed(error);
      },
    );
    return { kind: 'attempting', attempt, restart };
  }
}

/**
 * Whether a thread runs the engine: none yet or none since the last stop
 * that closed it, a session, or a stop that ends its session, which every
 * later call waits for.
 */
type QueuePhase =
  | { kind: 'closed' }
  | { kind: 'open'; session: Session }
  | { kind: 'closing'; closed: Future<void> };

/**
 * pg-boss's job queue on a SQLite file, run by `SqliteJobQueue` in a worker
 * thread. `node:sqlite` is synchronous, so the engine's commits, fsyncs and
 * busy waits block that thread and never the host's. The `work()` handlers
 * run on the host. A thread that ends outside a stop is started again, as
 * pg-boss reconnects (db.js:129-178).
 */
export class SqliteJobQueueThread
  extends EventEmitter<
    Pick<PgBossEventMap, 'error' | 'warning' | 'wip' | 'stopped'>
  >
  implements JobQueue, AsyncDisposable
{
  readonly #options: EngineOptions;
  readonly #resourceLimits: ResourceLimits | undefined;
  readonly #clock: Clock;
  readonly #remote: boolean;
  /** When the queue was made, on its clock: the engine counts its wip window from then (manager.js:248). */
  readonly #madeAt: number;
  readonly #works = new Map<number, Work>();
  #nextWork = 0;
  #phase: QueuePhase = { kind: 'closed' };
  readonly #host: ThreadHost;

  constructor(options: SqliteJobQueueThreadOptions) {
    super();
    const { clock, resourceLimits, ...engine } = options;
    // The checks of SqliteJobQueue's constructor, so a bad option throws
    // here, as on the main thread (attorney.js:422, 424, 429).
    this.#clock = Attorney.applyClockConfig(clock);
    Attorney.applyOpsConfig(engine);
    Attorney.applyScheduleConfig(engine);
    Attorney.validateWarningConfig(engine);
    this.#remote = this.#clock !== systemClock;
    this.#madeAt = this.#clock.now();
    this.#options = engine;
    this.#resourceLimits = resourceLimits;
    this.#host = this.#threadHost();
    const followErrorListeners = (event: string | symbol) => {
      if (event !== 'error') return;
      queueMicrotask(() => this.#sendErrorListeners());
    };
    this.on('newListener', followErrorListeners);
    this.on('removeListener', followErrorListeners);
  }

  /**
   * Spawns the thread, if none runs, and starts the engine, which opens the
   * file. A failure rejects, and leaves no thread.
   */
  async start(options: StartOptions = {}): Promise<this> {
    const session = await this.#session();
    let thread: EngineThread;
    try {
      thread = await session.thread();
      await thread.call('start', [options]);
    } catch (error) {
      if (session.engine.kind === 'unstarted') await this.#close(session);
      throw error;
    }
    session.engine = { kind: 'started', options };
    const clock = this.#clock;
    if (this.#remote && Activity.isAttachable(clock)) {
      await session.attachOnce(() =>
        clock.attach({
          // The clock tells its database each time it moves: the thread hears it.
          db: {
            executeSql: async () => {
              session.live?.stamp();
              return { rows: [] };
            },
          },
          schema: 'sqlite job queue thread',
          idle: () => this.#idle(session),
        }),
      );
    }
    return this;
  }

  /**
   * Stops the engine. With `close`, the default, the thread ends too. A stop
   * of an engine that never started keeps each work(), as on the main
   * thread.
   */
  async stop(options: StopOptions = {}): Promise<void> {
    const phase = this.#phase;
    if (phase.kind === 'closed') return;
    if (phase.kind === 'closing') return phase.closed.wait();
    const { session } = phase;
    const { close = true } = options;
    const [attempt] = session.restarting
      ? []
      : await Promise.allSettled([session.thread()]);
    const thread = attempt?.status === 'fulfilled' ? attempt.value : undefined;
    if (!thread) {
      // The thread was lost: nothing runs to stop, and its restart stops.
      this.#works.clear();
      await this.#close(session);
      this.emit('stopped');
      return;
    }
    await thread.call('stop', [options]);
    // An engine that never started keeps its work(), as on the main thread,
    // and the next start registers it on a new thread.
    if (session.engine.kind === 'started') this.#works.clear();
    session.engine = { kind: 'unstarted' };
    if (close) await this.#close(session);
  }

  /** Stops the engine, ends the thread and waits for it to exit. */
  async [Symbol.asyncDispose]() {
    await this.stop({ close: true });
  }

  offWork(name: string, options?: OffWorkOptions): Promise<void>;
  async offWork(...args: [string, OffWorkOptions?]): Promise<void> {
    const [name, options] = args;
    const work =
      options?.id === undefined
        ? undefined
        : this.#works.values().find((each) => each.id === options.id);
    const crossing =
      work && options ? [name, { ...options, id: work.threadId }] : args;
    await this.#invoke('offWork', crossing, queueAnswers.offWork);
    for (const [key, each] of this.#works) {
      if (each.name === name && (options?.id === undefined || each === work)) {
        this.#works.delete(key);
      }
    }
  }

  createQueue(name: string, options?: Omit<Queue, 'name'>): Promise<void>;
  createQueue(...args: unknown[]) {
    return this.#invoke('createQueue', args, queueAnswers.createQueue);
  }

  updateQueue(name: string, options?: UpdateQueueOptions): Promise<void>;
  updateQueue(...args: unknown[]) {
    return this.#invoke('updateQueue', args, queueAnswers.updateQueue);
  }

  deleteQueue(name: string): Promise<void>;
  deleteQueue(...args: unknown[]) {
    return this.#invoke('deleteQueue', args, queueAnswers.deleteQueue);
  }

  getQueueStats(
    name: string,
    options?: QueueStatsOptions,
  ): Promise<QueueStats[]>;
  getQueueStats(...args: unknown[]) {
    return this.#invoke('getQueueStats', args, queueAnswers.getQueueStats);
  }

  getQueues(names?: string[], options?: ListOptions): Promise<ListedQueue[]>;
  getQueues(...args: unknown[]) {
    return this.#invoke('getQueues', args, queueAnswers.getQueues);
  }

  send(request: Request): Promise<string | null>;
  send(
    name: string,
    data?: object | null,
    options?: SendOptions,
  ): Promise<string | null>;
  send(...args: unknown[]) {
    return this.#invoke('send', args, queueAnswers.send);
  }

  work(name: string, handler: WorkHandler<unknown>): Promise<string>;
  work(
    name: string,
    options: WorkOptions,
    handler: WorkHandler<unknown>,
  ): Promise<string>;
  async work(
    name: string,
    ...args: [WorkHandler<unknown>] | [WorkOptions, WorkHandler<unknown>]
  ): Promise<string> {
    // The engine's checks, before the handler stays on this side.
    Attorney.checkWorkArgs(name, args);
    const options = args.length === 1 ? undefined : args[0];
    const handler = args.length === 1 ? args[0] : args[1];
    const thread = await (await this.#session()).thread();
    const key = this.#nextWork++;
    const work: Work = { name, options, handler, id: '', threadId: '' };
    this.#works.set(key, work);
    try {
      work.id = await thread.call('work', [name, key, options]);
    } catch (error) {
      this.#works.delete(key);
      throw error;
    }
    work.threadId = work.id;
    return work.id;
  }

  fetch(
    name: string,
    options: FetchOptions & { includeMetadata: true },
  ): Promise<JobWithMetadata<unknown>[]>;
  fetch(name: string, options?: FetchOptions): Promise<Job<unknown>[]>;
  fetch(...args: unknown[]) {
    return this.#invoke('fetch', args, queueAnswers.fetch);
  }

  findJobs(
    name: string,
    options?: FindJobsOptions,
  ): Promise<FoundJob<unknown>[]>;
  findJobs(...args: unknown[]) {
    return this.#invoke('findJobs', args, queueAnswers.findJobs);
  }

  cancel(
    name: string,
    id: string | string[] | JobAttempt | JobAttempt[],
  ): Promise<CommandResponse>;
  cancel(...args: unknown[]) {
    return this.#invoke('cancel', args, queueAnswers.cancel);
  }

  complete(
    name: string,
    id: string | string[] | JobAttempt | JobAttempt[],
    data?: object | null,
    options?: CompleteOptions,
  ): Promise<CommandResponse>;
  complete(...args: unknown[]) {
    return this.#invoke('complete', args, queueAnswers.complete);
  }

  touch(
    name: string,
    id: string | string[] | JobAttempt | JobAttempt[],
  ): Promise<CommandResponse>;
  touch(...args: unknown[]) {
    return this.#invoke('touch', args, queueAnswers.touch);
  }

  fail(
    name: string,
    id: string | string[] | JobAttempt | JobAttempt[],
    data?: unknown,
  ): Promise<CommandResponse>;
  fail(...args: unknown[]) {
    return this.#invoke('fail', args, queueAnswers.fail);
  }

  schedule(
    name: string,
    cron: string,
    data?: object | null,
    options?: ScheduleOptions,
  ): Promise<void>;
  schedule(...args: unknown[]) {
    return this.#invoke('schedule', args, queueAnswers.schedule);
  }

  unschedule(name: string, key?: string): Promise<void>;
  unschedule(...args: unknown[]) {
    return this.#invoke('unschedule', args, queueAnswers.unschedule);
  }

  /** A call waits for the thread's restart, and gets its error when that attempt fails. */
  async #invoke<Answer>(
    method: QueueMethod,
    args: readonly unknown[],
    check: (answer: unknown) => answer is Answer,
  ): Promise<Answer> {
    const thread = await this.#thread();
    const answer = await thread.call('invoke', [
      method,
      args.map((arg) => pack(arg)),
    ]);
    if (!check(answer)) {
      throw new TypeError(
        `The queue thread answered "${method}" with a value that its check refused.`,
      );
    }
    return answer;
  }

  /**
   * The thread of the open session. A call that only a started engine
   * answers needs no new thread: before start() it is refused as the
   * engine refuses it.
   */
  async #thread(): Promise<EngineThread> {
    const phase = this.#phase;
    if (phase.kind === 'closing') {
      await phase.closed.wait();
      return this.#thread();
    }
    if (phase.kind === 'closed') throw notOpened();
    return phase.session.thread();
  }

  /** The open session, or a new one: its thread comes for start() and for a work() before it (manager.js:1178-1180). */
  async #session(): Promise<Session> {
    const phase = this.#phase;
    if (phase.kind === 'open') return phase.session;
    if (phase.kind === 'closing') {
      await phase.closed.wait();
      return this.#session();
    }
    const session = new Session(
      (starting, wait) => this.#launch(starting, wait),
      (error) => this.#host.error(error),
    );
    this.#phase = { kind: 'open', session };
    return session;
  }

  /** Ends the session's thread. Calls meanwhile wait, then find the queue closed. */
  async #close(session: Session) {
    const closed = Future.run(() => session.end());
    this.#phase = { kind: 'closing', closed };
    try {
      await closed.wait();
    } finally {
      this.#phase = { kind: 'closed' };
    }
  }

  #sendErrorListeners() {
    if (this.#phase.kind !== 'open') return;
    this.#phase.session.live?.notify('errorListeners', [
      this.listenerCount('error'),
    ]);
  }

  /**
   * Waits `wait` ms on the clock, spawns a thread and opens the engine with
   * the host's error listeners. A restart then starts it with the last
   * options of start(), and registers each work() again. A thread whose
   * attempt failed or whose session ended meanwhile does not stay.
   */
  async #launch(session: Session, wait: number): Promise<EngineThread> {
    if (wait > 0) {
      await Timers.delay(this.#clock, wait, undefined, session.ended);
    }
    if (session.ended.signal.aborted) throw notOpened();
    const thread = new EngineThread(this.#host, this.#resourceLimits);
    try {
      await thread.call('open', [
        this.#options,
        this.#remote ? 'remote' : 'local',
        this.listenerCount('error'),
        this.#madeAt,
      ]);
      const { engine } = session;
      if (engine.kind === 'started') {
        await thread.call('start', [engine.options]);
      }
      for (const [key, work] of this.#works) {
        work.threadId = await thread.call('work', [
          work.name,
          key,
          work.options,
        ]);
      }
    } catch (error) {
      await thread.terminate();
      throw error;
    }
    if (session.ended.signal.aborted) {
      await thread.end();
      throw notOpened();
    }
    // The listeners may have changed while the attempt ran.
    thread.notify('errorListeners', [this.listenerCount('error')]);
    return thread;
  }

  async #idle(session: Session): Promise<boolean> {
    const thread = session.live;
    if (!thread) return false;
    try {
      return await thread.idle();
    } catch (error) {
      if (error instanceof ConnectionLostError) return false;
      throw error;
    }
  }

  #threadHost(): ThreadHost {
    const handlerOf = (key: number) => this.#works.get(key)?.handler;
    const idOf = (threadId: string) =>
      this.#works.values().find((work) => work.threadId === threadId)?.id ??
      threadId;
    return {
      clock: this.#clock,
      remote: this.#remote,
      handlerOf,
      error: (error) =>
        this.emit(
          'error',
          isErrorEvent(error) ? error : new Error(String(error)),
        ),
      warning: (warning) => this.emit('warning', warning),
      wip: (workers: CrossingWip) =>
        this.emit(
          'wip',
          workers.map((worker): WipData => ({
            ...worker,
            id: idOf(worker.id),
            workId: idOf(worker.workId),
            lastError: asObject(
              worker.lastError === null
                ? null
                : errors.decode(worker.lastError),
            ),
          })),
        ),
      stopped: () => this.emit('stopped'),
      lost: (thread) => {
        if (this.#phase.kind === 'open') this.#phase.session.lost(thread);
      },
    };
  }
}

// The engine emits pg-boss's spread copy of an error, which is no Error
// (manager.js:1057, 1297-1299), typed as one: the host's listener gets what
// the engine emitted.
function isErrorEvent(value: unknown): value is Error {
  return typeof value === 'object' && value !== null && 'message' in value;
}

function asObject(value: unknown): object | null {
  return typeof value === 'object' ? value : { value };
}
