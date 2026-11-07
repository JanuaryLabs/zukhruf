import type { Comparator } from '../comparator.ts';
import type { LeafValue } from '../leaf-pair.ts';

// Two leaves agree when JSON Schema calls them equal (2020-12, Core section
// 4.2.2): the same type and the same value. A number is one type, so the int
// 1 agrees with the float 1.0, exactly; true does not agree with 1.
export class JsonEquality implements Comparator {
  agrees(stated: LeafValue, expected: LeafValue): boolean {
    if (typeof stated === 'bigint' && typeof expected === 'number')
      return JsonEquality.#intIsFloat(stated, expected);
    if (typeof stated === 'number' && typeof expected === 'bigint')
      return JsonEquality.#intIsFloat(expected, stated);
    return stated === expected;
  }

  // An int equals a float when the float is integral and has the same value,
  // exactly.
  static #intIsFloat(int: bigint, float: number): boolean {
    return Number.isInteger(float) && BigInt(float) === int;
  }
}
