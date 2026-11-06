import type { Check } from './check.ts';
import { Gauge, type Value } from './gauge.ts';

// A gauge made of gauges: its value is the values of its members. It changes
// when one member changes, and fails when one member fails. It keeps a copy
// of the members, so it cannot contain itself.
export class Group extends Gauge<readonly Value[]> {
  readonly #members: readonly Gauge[];

  constructor(members: readonly Gauge[]) {
    super();
    this.#members = [...members];
  }

  protected read(check: Check): Promise<readonly Value[]> {
    return Promise.all(this.#members.map((member) => member.value(check)));
  }
}
