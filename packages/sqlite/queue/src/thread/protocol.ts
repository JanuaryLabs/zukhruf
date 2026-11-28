import { AssertionError } from 'node:assert';

import type {
  CommandResponse,
  Job,
  QueueStats,
  StopOptions,
  Warning,
  WipData,
  WorkOptions,
} from 'pg-boss';

import { type EncodedReason, ErrorCodec, isEncodedReason } from '@zukhruf/rpc';
import {
  DeniedError,
  MissingError,
  UnavailableError,
} from '@zukhruf/sqlite-open';

import { DatabaseError } from '../database-error.ts';
import type { SqliteJobQueueOptions } from '../index.ts';
import type { FoundJob, ListedQueue, StartOptions } from '../job-queue.ts';
import { SqliteJobQueueWarning } from '../sqlite-job-queue-warning.ts';
import { UnsupportedStartAfterError } from '../start-after.ts';
import { TimekeeperWarning } from '../timekeeper-warning.ts';

/** The envelope of the queue's messages on the port of its thread. */
export const tag = '@zukhruf/sqlite-queue';

/**
 * The classes the engine throws or warns with. The built-ins, and the errors
 * of `node:sqlite` (an `Error` with `errcode` and `errstr`), cross without a
 * list, so `instanceof` and the result code read as on the main thread.
 */
export const errors = new ErrorCodec([
  AssertionError,
  DatabaseError,
  DeniedError,
  MissingError,
  UnavailableError,
  UnsupportedStartAfterError,
  SqliteJobQueueWarning,
  TimekeeperWarning,
]);

/** The engine's options as they cross: no `database` and no clock, which cannot cross a thread. */
export type EngineOptions = Omit<
  SqliteJobQueueOptions,
  'database' | 'clock'
> & {
  path: string;
};

/**
 * `local`: the thread runs the engine on its own timers, as the main thread
 * would on `systemClock`. `remote`: every timer and every read of the time
 * goes to the host's clock.
 */
export type ClockKind = 'local' | 'remote';

/** A job as it crosses to the host's handler: the signal stays in the thread, and its aborts follow as `abort`. */
export type CrossingJob = Omit<Job<unknown>, 'signal'>;

/** A wip event as it crosses: a worker's last error is encoded, so it keeps its class and fields. */
export type CrossingWip = (Omit<WipData, 'lastError'> & {
  lastError: EncodedReason | null;
})[];

/** The methods the thread serves, which the host calls. */
export interface ThreadMethods {
  /** Makes the engine, as at `madeAt` of the host's clock, when the queue was made. */
  open(
    options: EngineOptions,
    clock: ClockKind,
    errorListeners: number,
    madeAt: number,
  ): void;
  start(options: StartOptions): Promise<void>;
  stop(options: StopOptions): Promise<void>;
  /** Runs the engine's `work`; each batch goes to the host's handler of `key`. */
  work(
    name: string,
    key: number,
    options: WorkOptions | undefined,
  ): Promise<string>;
  /** One of the engine's `JobQueue` methods, called with `args` as the host's caller gave them. */
  invoke(method: QueueMethod, args: readonly unknown[]): Promise<unknown>;
  /** Whether the engine had statements in flight to wait for: the `idle` of an attached `TestClock`. */
  idle(): Promise<boolean>;
  /** The time of the host's clock, which comes before each message of the host. */
  time(now: number): void;
  /** A timer that the host armed for the thread is due. */
  fire(timer: number): void;
  /** How many `'error'` listeners the host has. */
  errorListeners(count: number): void;
  /** Lets the thread exit: nothing more comes. */
  end(): Promise<void>;
}

/** The methods the host serves, which the thread calls. */
export interface HostMethods {
  /** Runs the handler of `key` on a batch, and answers with its output. */
  handle(key: number, batch: number, jobs: CrossingJob[]): unknown;
  /** The signal of one job of a batch aborted. */
  abort(batch: number, job: string, reason: EncodedReason): void;
  arm(timer: number, ms: number, repeat: boolean): void;
  disarm(timer: number): void;
  error(error: EncodedReason): void;
  warning(warning: Warning): void;
  wip(workers: CrossingWip): void;
  stopped(): void;
  /** A `process.emitWarning` of the thread, which the host emits under its own flags. */
  processWarning(warning: EncodedReason): void;
}

/** The engine's methods that cross as they are, by name. */
export const queueMethods = [
  'offWork',
  'createQueue',
  'updateQueue',
  'deleteQueue',
  'getQueueStats',
  'getQueues',
  'send',
  'fetch',
  'findJobs',
  'cancel',
  'complete',
  'touch',
  'fail',
  'schedule',
  'unschedule',
] as const;

export type QueueMethod = (typeof queueMethods)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number';
const isVoid = (value: unknown): value is void => value === undefined;
const isQueueMethod = (value: unknown): value is QueueMethod =>
  queueMethods.some((method) => method === value);

/**
 * The checks of what reaches the thread. The engine checks each argument of
 * its own methods (`Attorney`, as pg-boss does), so `invoke` checks only the
 * method's name and that the arguments are a list.
 */
export const threadParams = {
  open: (params): params is [EngineOptions, ClockKind, number, number] =>
    params.length === 4 &&
    isRecord(params[0]) &&
    isString(params[0].path) &&
    (params[1] === 'local' || params[1] === 'remote') &&
    isNumber(params[2]) &&
    isNumber(params[3]),
  start: (params): params is [StartOptions] =>
    params.length === 1 && isRecord(params[0]),
  stop: (params): params is [StopOptions] =>
    params.length === 1 && isRecord(params[0]),
  work: (params): params is [string, number, WorkOptions | undefined] =>
    params.length === 3 && isString(params[0]) && isNumber(params[1]),
  invoke: (params): params is [QueueMethod, readonly unknown[]] =>
    params.length === 2 && isQueueMethod(params[0]) && Array.isArray(params[1]),
  idle: (params): params is [] => params.length === 0,
  time: (params): params is [number] =>
    params.length === 1 && isNumber(params[0]),
  fire: (params): params is [number] =>
    params.length === 1 && isNumber(params[0]),
  errorListeners: (params): params is [number] =>
    params.length === 1 && isNumber(params[0]),
  end: (params): params is [] => params.length === 0,
} satisfies {
  [M in keyof ThreadMethods]: (
    params: readonly unknown[],
  ) => params is Parameters<ThreadMethods[M]>;
};

/** The checks of what reaches the host. */
export const hostParams = {
  handle: (params): params is [number, number, CrossingJob[]] =>
    params.length === 3 &&
    isNumber(params[0]) &&
    isNumber(params[1]) &&
    Array.isArray(params[2]),
  abort: (params): params is [number, string, EncodedReason] =>
    params.length === 3 &&
    isNumber(params[0]) &&
    isString(params[1]) &&
    isEncodedReason(params[2]),
  arm: (params): params is [number, number, boolean] =>
    params.length === 3 &&
    isNumber(params[0]) &&
    isNumber(params[1]) &&
    typeof params[2] === 'boolean',
  disarm: (params): params is [number] =>
    params.length === 1 && isNumber(params[0]),
  error: (params): params is [EncodedReason] =>
    params.length === 1 && isEncodedReason(params[0]),
  warning: (params): params is [Warning] =>
    params.length === 1 && isRecord(params[0]) && isString(params[0].message),
  wip: (params): params is [CrossingWip] =>
    params.length === 1 && Array.isArray(params[0]),
  stopped: (params): params is [] => params.length === 0,
  processWarning: (params): params is [EncodedReason] =>
    params.length === 1 && isEncodedReason(params[0]),
} satisfies {
  [M in keyof HostMethods]: (
    params: readonly unknown[],
  ) => params is Parameters<HostMethods[M]>;
};

/** The answers of the thread, each checked before the host gives it its type. */
export const threadAnswers = {
  open: isVoid,
  start: isVoid,
  stop: isVoid,
  work: isString,
  invoke: (answer): answer is unknown => true,
  idle: (answer): answer is boolean => typeof answer === 'boolean',
  time: isVoid,
  fire: isVoid,
  errorListeners: isVoid,
  end: isVoid,
} satisfies {
  [M in keyof ThreadMethods]: (
    answer: unknown,
  ) => answer is Awaited<ReturnType<ThreadMethods[M]>>;
};

/** The answers of the host. A handler's output is any value, as on the main thread. */
export const hostAnswers = {
  handle: (answer): answer is unknown => true,
  abort: isVoid,
  arm: isVoid,
  disarm: isVoid,
  error: isVoid,
  warning: isVoid,
  wip: isVoid,
  stopped: isVoid,
  processWarning: isVoid,
} satisfies {
  [M in keyof HostMethods]: (
    answer: unknown,
  ) => answer is Awaited<ReturnType<HostMethods[M]>>;
};

/**
 * The answer of each `invoke`d method, checked before the host gives it the
 * method's type. The engine built the value, so the check reads its outer
 * shape.
 */
export const queueAnswers = {
  offWork: isVoid,
  createQueue: isVoid,
  updateQueue: isVoid,
  deleteQueue: isVoid,
  getQueueStats: (answer): answer is QueueStats[] => Array.isArray(answer),
  getQueues: (answer): answer is ListedQueue[] => Array.isArray(answer),
  send: (answer): answer is string | null =>
    answer === null || isString(answer),
  fetch: (answer): answer is Job<unknown>[] => Array.isArray(answer),
  findJobs: (answer): answer is FoundJob<unknown>[] => Array.isArray(answer),
  cancel: (answer): answer is CommandResponse => isRecord(answer),
  complete: (answer): answer is CommandResponse => isRecord(answer),
  touch: (answer): answer is CommandResponse => isRecord(answer),
  fail: (answer): answer is CommandResponse => isRecord(answer),
  schedule: isVoid,
  unschedule: isVoid,
} satisfies Record<QueueMethod, (answer: unknown) => boolean>;

/** The key of a value that the structured clone cannot carry as the engine reads it. */
const crossed = '@zukhruf/sqlite-queue/crossed';

type Crossed =
  | { [crossed]: 'function'; fields: unknown }
  | { [crossed]: 'symbol'; description: string | undefined }
  | {
      [crossed]: 'toJSON';
      fields: unknown;
      json: { value: unknown } | { thrown: EncodedReason };
    };

const isCrossed = (value: unknown): value is Crossed =>
  isRecord(value) && Object.hasOwn(value, crossed);

/** The own enumerable fields of `value`, without its `toJSON`, which crosses as what it gave. */
const ownFields = (value: object) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'toJSON'));

/**
 * An argument or an output, made ready to cross to the other thread. The
 * structured clone drops a function, a symbol and a `toJSON` method, which
 * the engine reads: it refuses a function as data, keeps the fields of a
 * function in a list of results, and stores data as `JSON.stringify` makes it
 * (manager.js:1639-1642, plans.js:2991-3083). Each of them crosses as a
 * record that `unpack` makes again: a function with its fields, a symbol with
 * its description, and an object with its fields and what its `toJSON`
 * returned or threw. Every other value crosses as the structured clone copies
 * it.
 */
export function pack(
  value: unknown,
  copies = new WeakMap<object, unknown>(),
): unknown {
  if (typeof value === 'symbol') {
    return { [crossed]: 'symbol', description: value.description };
  }
  if (typeof value === 'function') {
    return { [crossed]: 'function', fields: pack(ownFields(value), copies) };
  }
  if (typeof value !== 'object' || value === null) return value;
  const copy = copies.get(value);
  if (copy !== undefined) return copy;
  const toJSON: unknown = Reflect.get(value, 'toJSON');
  if (typeof toJSON === 'function' && !(value instanceof Date)) {
    let json: { value: unknown } | { thrown: EncodedReason };
    try {
      json = { value: pack(Reflect.apply(toJSON, value, ['']), copies) };
    } catch (thrown) {
      json = { thrown: errors.encode(thrown) };
    }
    const packed: Crossed = { [crossed]: 'toJSON', fields: {}, json };
    copies.set(value, packed);
    packed.fields = pack(ownFields(value), copies);
    return packed;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    copies.set(value, items);
    for (const item of value) items.push(pack(item, copies));
    return items;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const fields: Record<string, unknown> = {};
  copies.set(value, fields);
  for (const [key, item] of Object.entries(value)) {
    fields[key] = pack(item, copies);
  }
  return fields;
}

/** The value that `pack` made ready, as the engine reads it on this side. */
export function unpack(
  value: unknown,
  copies = new WeakMap<object, unknown>(),
): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const copy = copies.get(value);
  if (copy !== undefined) return copy;
  if (isCrossed(value)) {
    const kind = value[crossed];
    if (kind === 'symbol') return Symbol(value.description);
    if (kind === 'function') {
      const made = () => {};
      copies.set(value, made);
      return Object.assign(made, unpack(value.fields, copies));
    }
    const { json } = value;
    const made: Record<string, unknown> = {};
    copies.set(value, made);
    Object.assign(made, unpack(value.fields, copies), {
      toJSON: () => {
        if ('thrown' in json) throw errors.decode(json.thrown);
        return unpack(json.value, copies);
      },
    });
    return made;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    copies.set(value, items);
    for (const item of value) items.push(unpack(item, copies));
    return items;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const fields: Record<string, unknown> = {};
  copies.set(value, fields);
  for (const [key, item] of Object.entries(value)) {
    fields[key] = unpack(item, copies);
  }
  return fields;
}
