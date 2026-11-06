import type { Check } from './check.ts';
import { Gauge, type Primitive } from './gauge.ts';
import { Once } from './once.ts';

// The value of one key of a collector. It is not undefined: undefined means
// that the read did not give the key.
export type Sample = Exclude<Primitive, undefined>;

// One read that gives the values of many keys, for example one query that
// gives a count for each table of a database. gauge(key) gives a new gauge of
// one key: keep the object that you watch, because two calls give two gauges.
export abstract class Collector<K> {
  readonly #once = new Once<ReadonlyMap<K, Sample>>();

  protected abstract collect(check: Check): Promise<ReadonlyMap<K, Sample>>;

  gauge(key: K): Gauge<Primitive> {
    return new Collector.#Key(this, key);
  }

  // The value of one key, or undefined when the read did not give the key:
  // a key that appears or disappears changes.
  static #Key = class Key<K> extends Gauge<Primitive> {
    readonly #collector: Collector<K>;
    readonly #key: K;

    constructor(collector: Collector<K>, key: K) {
      super();
      this.#collector = collector;
      this.#key = key;
    }

    protected async read(check: Check) {
      const collector = this.#collector;
      const values = await collector.#once.of(check, () =>
        collector.collect(check),
      );
      return values.get(this.#key);
    }
  };
}
