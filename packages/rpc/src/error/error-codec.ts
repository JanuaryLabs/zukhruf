import { isRecord } from '../shared/is-record.ts';
import { ServerError } from './server-error.ts';

/** A class whose instances the codec rebuilds. Its constructor never runs on the decoding end. */
export type ErrorClass = abstract new (...args: never[]) => Error;

/** An error as it crosses: its class, its text and its own fields; `cause` crosses the same way. */
export interface EncodedError {
  /** The name of the error's own class: the `name` of its constructor. */
  name: string;
  message: string;
  stack: string | undefined;
  /** The error's own properties other than `message`, `stack` and `cause`, such as `code`. */
  fields: Record<string, unknown>;
  cause?: EncodedReason;
}

/** A thrown value that is not an error crosses as it is. */
export interface EncodedValue {
  value: unknown;
}

/**
 * A `DOMException` as it crosses: its name, which sets its `code`, its text
 * and its cause. WebIDL serializes a DOMException by its name, message and
 * stack, and so does the codec, with the cause, which the codec keeps for
 * every error. A subclass crosses as a plain DOMException, as WebIDL's steps
 * give it, and the own fields of a subclass, such as those of
 * `QuotaExceededError`, stay behind.
 */
export interface EncodedDOMException {
  domException: {
    name: string;
    message: string;
    stack: string | undefined;
    cause?: EncodedReason;
  };
}

export type EncodedReason = EncodedError | EncodedDOMException | EncodedValue;

/**
 * The native error classes, which the structured clone of HTML keeps by name
 * (HTML, "StructuredSerializeInternal", step for [[ErrorData]]). The codec
 * knows them without a list.
 */
const natives: readonly ErrorClass[] = [
  Error,
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
];

/** The own properties that the codec carries apart from `fields`. */
const carried = new Set(['message', 'stack', 'cause']);

/**
 * Turns a thrown value into data that a message channel or a JSON line can
 * carry, and back. `structuredClone` and `v8.serialize` rebuild every error as
 * its native base class and drop own fields such as `code`; this codec keeps
 * them. It rebuilds an error of a listed class, or of a native class, as an
 * instance of that class, with the peer's message, stack, cause and own
 * fields. It never runs the class's constructor, so a constructor's arguments
 * and side effects do not matter. A `DOMException` arrives as a
 * `DOMException` with its name, so its `code` too. An error of any other class
 * arrives as a `ServerError` that keeps the peer's name and fields.
 */
export class ErrorCodec {
  readonly #classes = new Map<string, ErrorClass>();

  /** Throws a `RangeError` when two classes have one name, because the name is what crosses. */
  constructor(classes: readonly ErrorClass[]) {
    for (const errorClass of [...natives, ...classes]) {
      const known = this.#classes.get(errorClass.name);
      if (known === errorClass) continue;
      if (known) {
        throw new RangeError(
          `Two error classes are named "${errorClass.name}": the codec tells them apart by name only.`,
        );
      }
      this.#classes.set(errorClass.name, errorClass);
    }
  }

  encode(reason: unknown): EncodedReason {
    if (isDOMException(reason)) {
      const encoded: EncodedDOMException = {
        domException: {
          name: reason.name,
          message: reason.message,
          stack: reason.stack,
        },
      };
      if (Object.hasOwn(reason, 'cause')) {
        encoded.domException.cause = this.encode(reason.cause);
      }
      return encoded;
    }
    if (!Error.isError(reason)) return { value: reason };
    const fields: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(reason)) {
      if (!carried.has(key)) fields[key] = Reflect.get(reason, key);
    }
    const encoded: EncodedError = {
      name: classNameOf(reason),
      message: reason.message,
      stack: reason.stack,
      fields,
    };
    if (Object.hasOwn(reason, 'cause')) {
      encoded.cause = this.encode(reason.cause);
    }
    return encoded;
  }

  decode(encoded: EncodedReason): unknown {
    if ('value' in encoded) return encoded.value;
    if ('domException' in encoded) {
      const { name, message, stack, cause } = encoded.domException;
      const error = new DOMException(
        message,
        cause ? { name, cause: this.decode(cause) } : { name },
      );
      define(error, 'stack', stack, false);
      return error;
    }
    const known = this.#classes.get(encoded.name);
    const error: Error = known
      ? Reflect.construct(nativeBaseOf(known), [encoded.message], known)
      : Reflect.construct(Error, [encoded.message], ServerError);
    if (!known) define(error, 'name', encoded.name, false);
    define(error, 'stack', encoded.stack, false);
    if (encoded.cause)
      define(error, 'cause', this.decode(encoded.cause), false);
    for (const [key, value] of Object.entries(encoded.fields)) {
      define(error, key, value, true);
    }
    return error;
  }
}

/** Whether `value` has the shape that `encode` gives, checked before a received reason is decoded. */
export function isEncodedReason(value: unknown): value is EncodedReason {
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, 'value')) return true;
  if (Object.hasOwn(value, 'domException')) {
    const { domException } = value;
    return (
      isRecord(domException) &&
      typeof domException.name === 'string' &&
      typeof domException.message === 'string' &&
      (domException.stack === undefined ||
        typeof domException.stack === 'string') &&
      (domException.cause === undefined || isEncodedReason(domException.cause))
    );
  }
  return (
    typeof value.name === 'string' &&
    typeof value.message === 'string' &&
    (value.stack === undefined || typeof value.stack === 'string') &&
    isRecord(value.fields) &&
    (value.cause === undefined || isEncodedReason(value.cause))
  );
}

/**
 * Whether `value` is a `DOMException`, by its brand: the getter of `name`
 * refuses a receiver that is no DOMException (WebIDL, "attribute getter"),
 * also an object made from its prototype, which `instanceof` takes. A
 * DOMException is a native error too, so this is checked before the error.
 */
function isDOMException(value: unknown): value is DOMException {
  try {
    Reflect.get(DOMException.prototype, 'name', value);
    return true;
  } catch (refusal) {
    if (refusal instanceof TypeError) return false;
    throw refusal;
  }
}

/** The name of the error's own class, or its `name` when its class has none. */
function classNameOf(error: Error): string {
  const prototype: unknown = Object.getPrototypeOf(error);
  const constructor: unknown = isRecord(prototype)
    ? prototype.constructor
    : undefined;
  return typeof constructor === 'function' && constructor.name !== ''
    ? constructor.name
    : error.name;
}

/** The native class that `errorClass` extends, so the rebuilt error is a native error, as `Error.isError` checks. */
function nativeBaseOf(errorClass: ErrorClass): ErrorClass {
  for (
    let current: unknown = errorClass;
    typeof current === 'function';
    current = Object.getPrototypeOf(current)
  ) {
    const native = natives.find((candidate) => candidate === current);
    if (native) return native;
  }
  return Error;
}

/** An own data property, also for a key such as `__proto__`, which an assignment would not make. */
function define(
  error: Error,
  key: string,
  value: unknown,
  enumerable: boolean,
) {
  Object.defineProperty(error, key, {
    value,
    enumerable,
    writable: true,
    configurable: true,
  });
}
