import type { Comparer } from '../scoring/comparer.ts';
import type { LabelCase } from './label-case.ts';
import { LabelComparison } from './label-comparison.ts';
import { type Label, isLabel } from './label.ts';

// Reads the stated labels of an answer and gives its comparison with the case
// (Strategy). A label or a list of labels is read as it is. Text is read so:
// a JSON array of labels gives those labels; a number gives a number label
// only when each expected label of the case is a number; any other text,
// without its white space at the start and the end, is one string label.
// Its comparisons hold the class set: the classes of the task, in the order
// that the caller gives (scikit-learn's labels). The answers never add a
// class.
export class LabelComparer implements Comparer<LabelCase, LabelComparison> {
  readonly #labels: readonly Label[];

  constructor({ labels }: { readonly labels: readonly Label[] }) {
    this.#labels = labels;
  }

  compare(stated: unknown, testCase: LabelCase): LabelComparison {
    return new LabelComparison({
      stated: new Set(LabelComparer.#stated(stated, testCase)),
      expected: testCase.expected,
      labels: this.#labels,
    });
  }

  static #stated(stated: unknown, testCase: LabelCase): readonly Label[] {
    if (Array.isArray(stated) && stated.every(isLabel)) return stated;
    if (typeof stated === 'number' && isLabel(stated)) return [stated];
    if (typeof stated !== 'string')
      throw new TypeError(
        `A stated answer is a label, a list of labels or text, not ${JSON.stringify(stated)}`,
      );
    const text = stated.trim();
    const value = LabelComparer.#parse(text);
    if (Array.isArray(value) && value.every(isLabel)) return value;
    if (
      typeof value === 'number' &&
      isLabel(value) &&
      testCase.expected.size > 0 &&
      [...testCase.expected].every((label) => typeof label === 'number')
    )
      return [value];
    return [text];
  }

  static #parse(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }
}
