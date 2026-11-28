import { NoServerError, UnsafeFolderError } from '@zukhruf/pipes';
import { type EncodedReason, ErrorCodec, isEncodedReason } from '@zukhruf/rpc';
import {
  DeniedError,
  MissingError,
  UnavailableError,
} from '@zukhruf/sqlite-open';

import { DisposedError } from '../disposed-error.ts';
import type { FileOptions, Notification } from '../notifications.ts';
import { QueueFullError } from '../queue-full-error.ts';

/** The envelope of the messages of the notifications on the port of their thread. */
export const tag = '@zukhruf/sqlite-notify';

/**
 * The classes that the notifications throw or give to `error`. The built-ins,
 * and the errors of `node:sqlite` (an `Error` with `errcode` and `errstr`),
 * cross without a list, so `instanceof` and the result code read as on the
 * main thread.
 */
export const errors = new ErrorCodec([
  DeniedError,
  DisposedError,
  MissingError,
  NoServerError,
  QueueFullError,
  UnavailableError,
  UnsafeFolderError,
]);

/** The options of the notifications as they cross: the clock cannot cross a thread. */
export type EngineOptions = Omit<FileOptions, 'database' | 'clock'>;

/**
 * `local`: the thread runs the notifications on its own timers, as the main
 * thread would on `globalThis`. `remote`: every timer and every read of the
 * time goes to the host's clock.
 */
export type ClockKind = 'local' | 'remote';

/** The methods the thread serves, which the host calls. */
export interface ThreadMethods {
  open(options: EngineOptions, clock: ClockKind): void;
  listen(channel: string): Promise<void>;
  unlisten(channel: string): Promise<void>;
  notify(channel: string, payload: string): void;
  /** Disposes the notifications: their listener's rows and socket go. */
  dispose(): Promise<void>;
  /** The time of the host's clock, which comes before each message of the host. */
  time(now: number): void;
  /** A timer that the host armed for the thread is due. */
  fire(timer: number): void;
  /** Lets the thread exit: nothing more comes. */
  end(): Promise<void>;
}

/** The methods the host serves, which the thread calls. */
export interface HostMethods {
  notification(notification: Notification): void;
  error(error: EncodedReason): void;
  arm(timer: number, ms: number): void;
  disarm(timer: number): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number';
const isVoid = (value: unknown): value is void => value === undefined;

/** The checks of what reaches the thread. The notifications check a channel and a payload themselves. */
export const threadParams = {
  open: (params): params is [EngineOptions, ClockKind] =>
    params.length === 2 &&
    isRecord(params[0]) &&
    isString(params[0].path) &&
    (params[1] === 'local' || params[1] === 'remote'),
  listen: (params): params is [string] =>
    params.length === 1 && isString(params[0]),
  unlisten: (params): params is [string] =>
    params.length === 1 && isString(params[0]),
  notify: (params): params is [string, string] =>
    params.length === 2 && isString(params[0]) && isString(params[1]),
  dispose: (params): params is [] => params.length === 0,
  time: (params): params is [number] =>
    params.length === 1 && isNumber(params[0]),
  fire: (params): params is [number] =>
    params.length === 1 && isNumber(params[0]),
  end: (params): params is [] => params.length === 0,
} satisfies {
  [M in keyof ThreadMethods]: (
    params: readonly unknown[],
  ) => params is Parameters<ThreadMethods[M]>;
};

/** The checks of what reaches the host. */
export const hostParams = {
  notification: (params): params is [Notification] =>
    params.length === 1 &&
    isRecord(params[0]) &&
    isNumber(params[0].processId) &&
    isString(params[0].channel) &&
    isString(params[0].payload),
  error: (params): params is [EncodedReason] =>
    params.length === 1 && isEncodedReason(params[0]),
  arm: (params): params is [number, number] =>
    params.length === 2 && isNumber(params[0]) && isNumber(params[1]),
  disarm: (params): params is [number] =>
    params.length === 1 && isNumber(params[0]),
} satisfies {
  [M in keyof HostMethods]: (
    params: readonly unknown[],
  ) => params is Parameters<HostMethods[M]>;
};

/** The answers of the thread, each checked before the host gives it its type. */
export const threadAnswers = {
  open: isVoid,
  listen: isVoid,
  unlisten: isVoid,
  notify: isVoid,
  dispose: isVoid,
  time: isVoid,
  fire: isVoid,
  end: isVoid,
} satisfies {
  [M in keyof ThreadMethods]: (
    answer: unknown,
  ) => answer is Awaited<ReturnType<ThreadMethods[M]>>;
};

/** The answers of the host. */
export const hostAnswers = {
  notification: isVoid,
  error: isVoid,
  arm: isVoid,
  disarm: isVoid,
} satisfies {
  [M in keyof HostMethods]: (
    answer: unknown,
  ) => answer is Awaited<ReturnType<HostMethods[M]>>;
};
