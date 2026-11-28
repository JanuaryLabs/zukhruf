// The worker thread of a SqliteJobQueueThread: it runs the engine on the
// queue file and serves it to the host over the port to its parent.
import { setImmediate } from 'node:timers/promises';
import { parentPort } from 'node:worker_threads';

import type { Job, StopOptions, WorkOptions } from 'pg-boss';

import {
  Client,
  ConnectionSupervisor,
  ParentPortConnection,
  type RpcMessage,
  Server,
} from '@zukhruf/rpc';

import { SqliteJobQueue } from '../index.ts';
import type { StartOptions } from '../job-queue.ts';
import { HostClock } from './host-clock.ts';
import {
  type ClockKind,
  type EngineOptions,
  type HostMethods,
  type QueueMethod,
  type ThreadMethods,
  errors,
  hostAnswers,
  tag,
  threadParams,
  unpack,
} from './protocol.ts';

/** The engine of the thread: none until the host opens it. */
type Engine = { kind: 'unopened' } | { kind: 'open'; queue: SqliteJobQueue };

/** The methods the host calls, on the engine of this thread. */
class QueueThread implements ThreadMethods {
  readonly #host: Client<HostMethods>;
  readonly #clock: HostClock;
  readonly #link: ConnectionSupervisor<RpcMessage>;
  #engine: Engine = { kind: 'unopened' };
  #nextBatch = 0;

  readonly #forwardError = (error: Error) =>
    this.#host.notify('error', [errors.encode(error)]);

  constructor(
    host: Client<HostMethods>,
    link: ConnectionSupervisor<RpcMessage>,
  ) {
    this.#host = host;
    this.#link = link;
    this.#clock = new HostClock(host);
  }

  open(
    options: EngineOptions,
    kind: ClockKind,
    errorListeners: number,
    madeAt: number,
  ) {
    const host = this.#host;
    const queue =
      kind === 'remote'
        ? this.#onHostClock(options, madeAt)
        : new SqliteJobQueue(options);
    queue.on('warning', (warning) => host.notify('warning', [warning]));
    queue.on('wip', (workers) =>
      host.notify('wip', [
        workers.map((worker) => ({
          ...worker,
          lastError:
            worker.lastError === null ? null : errors.encode(worker.lastError),
        })),
      ]),
    );
    queue.on('stopped', () => host.notify('stopped', []));
    this.#engine = { kind: 'open', queue };
    this.errorListeners(errorListeners);
  }

  async start(options: StartOptions) {
    await this.#queue().start(options);
  }

  async stop(options: StopOptions) {
    await this.#queue().stop(options);
  }

  async work(name: string, key: number, options: WorkOptions | undefined) {
    const handler = this.#handlerOf(key);
    return options === undefined
      ? this.#queue().work(name, handler)
      : this.#queue().work(name, options, handler);
  }

  async invoke(method: QueueMethod, args: readonly unknown[]) {
    const queue = this.#queue();
    return Reflect.apply(
      queue[method],
      queue,
      args.map((arg) => unpack(arg)),
    );
  }

  /**
   * A TestClock gives its targets a turn of the event loop before it asks
   * them (clock.js:193-200). The engine's loop is this thread's, so the turn
   * is taken here.
   */
  async idle() {
    await setImmediate();
    return this.#clock.idle();
  }

  time(now: number) {
    this.#clock.update(now);
  }

  fire(timer: number) {
    this.#clock.fire(timer);
  }

  /**
   * The engine reacts to an 'error' that nobody hears (ERR_UNHANDLED_ERROR),
   * so it hears one here only while the host has a listener.
   */
  errorListeners(count: number) {
    if (this.#engine.kind === 'unopened') return;
    const { queue } = this.#engine;
    queue.off('error', this.#forwardError);
    if (count > 0) queue.on('error', this.#forwardError);
  }

  async end() {
    await this.#link.close();
  }

  /**
   * The engine on the host's clock, made as at `madeAt`. This thread then has
   * no time of its own: pg-boss times a worker's round on Date.now
   * (worker.js:64-67), which reads the host's clock too, as a host on a
   * TestClock reads it with its Date following the clock.
   */
  #onHostClock(options: EngineOptions, madeAt: number): SqliteJobQueue {
    const clock = this.#clock;
    // eslint-disable-next-line island/no-ambient-time -- this replaces the thread's ambient time with the clock the caller gave
    Date.now = () => clock.now();
    const now = clock.now();
    clock.update(madeAt);
    const queue = new SqliteJobQueue({ ...options, clock });
    clock.update(now);
    return queue;
  }

  #queue(): SqliteJobQueue {
    if (this.#engine.kind === 'unopened') {
      throw new Error('The queue thread has no open engine.');
    }
    return this.#engine.queue;
  }

  /**
   * Each batch goes to the host's handler, and each job's signal follows it
   * there as an abort. A job's signal also aborts after its handler returns,
   * when the batch settles (manager.js:606), so the listener stays until then.
   */
  #handlerOf(key: number) {
    return (jobs: Job<unknown>[]) => {
      const batch = this.#nextBatch++;
      for (const { id, signal } of jobs) {
        signal.addEventListener(
          'abort',
          () =>
            this.#host.notify('abort', [
              batch,
              id,
              errors.encode(signal.reason),
            ]),
          { once: true },
        );
      }
      return this.#host
        .call('handle', [
          key,
          batch,
          jobs.map(({ signal: _signal, ...job }) => job),
        ])
        .then((output) => unpack(output));
    };
  }
}

if (!parentPort) {
  throw new Error('The queue thread runs only as a worker thread.');
}
const connection = new ParentPortConnection<RpcMessage>(parentPort, { tag });
const link = new ConnectionSupervisor<RpcMessage>({
  connect: async () => connection,
});
const host = new Client<HostMethods>(link, { errors, answers: hostAnswers });

// Node prints a warning of this thread itself; the host emits it again, under
// its own flags, so a host started with --no-warnings prints none.
for (const printer of process.listeners('warning')) {
  process.off('warning', printer);
}
process.on('warning', (warning) => {
  host.notify('processWarning', [errors.encode(warning)]);
});

new Server(new QueueThread(host, link), {
  methods: threadParams,
  errors,
}).serve(link);
