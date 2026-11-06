import type { Check } from './check.ts';
import { Once } from './once.ts';

export type Primitive = string | number | bigint | boolean | null | undefined;

// What a gauge gives: a primitive, or a list of values, which compares
// member by member.
export type Value = Primitive | readonly Value[];

// A value read at a moment, for example the data_version of a SQLite file.
// value(check) reads at most one time in a check; a subclass says how to read.
export abstract class Gauge<V extends Value = Value> {
  readonly #once = new Once<V>();

  value(check: Check): Promise<V> {
    return this.#once.of(check, () => this.read(check));
  }

  protected abstract read(check: Check): Promise<V>;
}
