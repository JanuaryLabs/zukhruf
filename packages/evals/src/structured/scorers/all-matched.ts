import { Gate } from '../../scorers/gate.ts';
import type { Comparison } from '../comparison/comparison.ts';
import type { Leaf } from '../comparison/leaf-pair.ts';
import { canonicalJson } from '../cpython/python-text.ts';
import type { LeafOptions } from './leaf-matches.ts';

// 1 when every leaf pair of the comparison agrees and every item of every
// array has a pair, else 0. With nullIsMissing, a null leaf is no value, on
// both sides, as the matches of leaves read it. Its explanation names each
// array whose items do not all have a pair, and each leaf that does not
// agree.
export class AllMatched extends Gate<Comparison> {
  readonly #nullIsMissing: boolean;

  constructor({ nullIsMissing = false }: LeafOptions = {}) {
    super();
    this.#nullIsMissing = nullIsMissing;
  }

  holds(comparison: Comparison): boolean {
    return this.#differences(comparison).length === 0;
  }

  explain(comparison: Comparison): string {
    return this.#differences(comparison).join('; ');
  }

  #differences(comparison: Comparison): string[] {
    return [
      ...comparison
        .arrays()
        .filter(
          (items) =>
            items.paired !== items.expected || items.paired !== items.stated,
        )
        .map(
          (items) =>
            `${items.field}: ${items.paired} pairs of ${items.expected} expected and ${items.stated} stated items`,
        ),
      ...comparison
        .leaves({ nullIsMissing: this.#nullIsMissing })
        .filter((pair) => pair.agrees !== true)
        .map(
          (pair) =>
            `${(pair.expected ?? pair.stated).path}: expected ${AllMatched.#shown(pair.expected)}, stated ${AllMatched.#shown(pair.stated)}`,
        ),
    ];
  }

  static #shown(leaf: Leaf | undefined): string {
    return leaf === undefined ? 'nothing' : canonicalJson(leaf.value);
  }
}
