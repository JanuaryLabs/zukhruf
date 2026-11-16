type Fail = (path: string, problem: string) => Error;

/** The path of the document itself; its keys have their bare names. */
export const ROOT = '';

/**
 * Reads parsed JSON strictly: every key named, no other key, every string
 * non-empty. Each failure names the field path, such as open[0].title.
 */
export class Shape {
  readonly #fail: Fail;

  constructor(fail: Fail) {
    this.#fail = (path, problem) =>
      fail(path === ROOT ? 'the document' : path, problem);
  }

  /** An object with exactly the given keys. */
  object<Key extends string>(
    value: unknown,
    path: string,
    keys: readonly Key[],
  ): ReadonlyMap<Key, unknown> {
    const record = this.record(value, path);
    for (const key of Object.keys(record)) {
      if (!keys.some((each) => each === key)) {
        throw this.#fail(field(path, key), 'unknown key');
      }
    }
    for (const key of keys) {
      if (!Object.hasOwn(record, key)) {
        throw this.#fail(field(path, key), 'missing');
      }
    }
    return new Map(keys.map((key) => [key, record[key]]));
  }

  /** A map from names to values, such as the ledger's projects. */
  record(value: unknown, path: string): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) {
      throw this.#fail(path, 'expected an object');
    }
    return value;
  }

  list<Item>(
    value: unknown,
    path: string,
    item: (value: unknown, path: string) => Item,
  ): Item[] {
    if (!Array.isArray(value)) {
      throw this.#fail(path, 'expected an array');
    }
    return value.map((each: unknown, index) => item(each, `${path}[${index}]`));
  }

  text(value: unknown, path: string): string {
    if (typeof value !== 'string') {
      throw this.#fail(path, 'expected a string');
    }
    if (value.trim() === '') {
      throw this.#fail(path, 'must not be empty');
    }
    return value;
  }

  oneOf<Option extends string>(
    value: unknown,
    path: string,
    options: readonly Option[],
  ): Option {
    const text = this.text(value, path);
    const option = options.find((each) => each === text);
    if (option === undefined) {
      throw this.#fail(path, `expected one of ${options.join(', ')}`);
    }
    return option;
  }

  instant(value: unknown, path: string): string {
    const text = this.text(value, path);
    try {
      return Temporal.Instant.from(text).toString();
    } catch (error) {
      if (error instanceof RangeError) {
        throw this.#fail(path, 'expected an ISO 8601 instant');
      }
      throw error;
    }
  }
}

export function field(path: string, key: string): string {
  return path === ROOT ? key : `${path}.${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
