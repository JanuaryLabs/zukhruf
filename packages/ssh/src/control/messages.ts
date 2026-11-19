import {
  type Exit,
  type SessionStart,
  type TerminalModes,
  type WindowSize,
  isSignalOrVendorName,
} from '../session.ts';

// The JSON messages of the control protocol, and the checks that read them
// back: the other side of a socket is another process.

export type Request =
  | {
      readonly kind: 'dial';
      readonly network: 'tcp' | 'unix';
      readonly address: string;
    }
  | { readonly kind: 'session'; readonly start: SessionStart }
  /** Keeps the master serving while the connection is open, as an OpenSSH mux client does (channel_still_open counts SSH_CHANNEL_MUX_CLIENT). */
  | { readonly kind: 'hold' };

/** The answer to a request: the channel opened, the server refused it (OpenChannelError), or its open failed. */
export type Reply =
  | { readonly opened: true }
  | {
      readonly opened: false;
      readonly refused: { readonly code: number; readonly description: string };
    }
  | { readonly opened: false; readonly error: WireError };

/** How the channel of a session ended: with an exit, or with none and the error that ended the master's connection when one did. */
export type Ending =
  | { readonly kind: 'exit'; readonly exit: Exit }
  | { readonly kind: 'missing'; readonly cause?: WireError };

/** An error by its message, its `code` and its cause. */
export interface WireError {
  readonly message: string;
  readonly code?: string | number;
  readonly cause?: WireError;
}

export function toWire(error: unknown): WireError {
  if (!Error.isError(error)) return { message: String(error) };
  const code =
    'code' in error &&
    (typeof error.code === 'string' || typeof error.code === 'number')
      ? error.code
      : undefined;
  return {
    message: error.message,
    ...(code !== undefined && { code }),
    ...(error.cause !== undefined && { cause: toWire(error.cause) }),
  };
}

export function fromWire(wire: WireError): Error {
  const error = new Error(
    wire.message,
    wire.cause && { cause: fromWire(wire.cause) },
  );
  return wire.code === undefined
    ? error
    : Object.assign(error, { code: wire.code });
}

type Fields = Readonly<Record<string, unknown>>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null;
}

function isOptional<T>(
  value: unknown,
  is: (value: unknown) => value is T,
): value is T | undefined {
  return value === undefined || is(value);
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number';

export function isWireError(value: unknown): value is WireError {
  return (
    isFields(value) &&
    isString(value['message']) &&
    (value['code'] === undefined ||
      isString(value['code']) ||
      isNumber(value['code'])) &&
    isOptional(value['cause'], isWireError)
  );
}

export function isWindowSize(value: unknown): value is WindowSize {
  return (
    isFields(value) &&
    isNumber(value['rows']) &&
    isNumber(value['columns']) &&
    isOptional(value['width'], isNumber) &&
    isOptional(value['height'], isNumber)
  );
}

function isTerminalModes(value: unknown): value is TerminalModes {
  return isFields(value) && Object.values(value).every(isNumber);
}

function isStart(value: unknown): value is SessionStart {
  if (!isFields(value)) return false;
  const { command, env, pty } = value;
  return (
    isOptional(command, isString) &&
    isFields(env) &&
    Object.values(env).every(isString) &&
    (pty === undefined ||
      (isFields(pty) &&
        isString(pty['term']) &&
        isWindowSize(pty['size']) &&
        isOptional(pty['modes'], isTerminalModes)))
  );
}

export function isRequest(value: unknown): value is Request {
  if (!isFields(value)) return false;
  if (value['kind'] === 'dial') {
    return (
      (value['network'] === 'tcp' || value['network'] === 'unix') &&
      isString(value['address'])
    );
  }
  if (value['kind'] === 'hold') return true;
  return value['kind'] === 'session' && isStart(value['start']);
}

export function isReply(value: unknown): value is Reply {
  if (!isFields(value)) return false;
  if (value['opened'] === true) return true;
  const refused = value['refused'];
  return (
    value['opened'] === false &&
    (isWireError(value['error']) ||
      (isFields(refused) &&
        isNumber(refused['code']) &&
        isString(refused['description'])))
  );
}

function isExit(value: unknown): value is Exit {
  if (!isFields(value)) return false;
  if (value['kind'] === 'status') return isNumber(value['exitStatus']);
  const signal = value['signal'];
  return (
    value['kind'] === 'signal' &&
    isSignalOrVendorName(signal) &&
    typeof value['coreDumped'] === 'boolean' &&
    isString(value['errorMessage'])
  );
}

export function isEnding(value: unknown): value is Ending {
  if (!isFields(value)) return false;
  if (value['kind'] === 'exit') return isExit(value['exit']);
  return value['kind'] === 'missing' && isOptional(value['cause'], isWireError);
}
