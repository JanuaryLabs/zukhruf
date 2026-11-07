import { Field } from './field.ts';
import { NameSelector } from './name-selector.ts';

// One step from a value to a value under it: a key of an object, or the
// position of an item in an array.
export type Step = string | number;

// The steps to one value. A path is its steps, not a string, so a key that
// holds "." or "[", or an empty key, is one step: {"a.b": 1} and
// {"a": {"b": 1}} have different paths (ADR 0011).
export class Path {
  readonly steps: readonly Step[];

  constructor(steps: readonly Step[]) {
    this.steps = steps;
  }

  child(step: Step): Path {
    return new Path([...this.steps, step]);
  }

  // The path as a JSONPath query (RFC 9535), with an index selector for each
  // position, such as $.offers[1].value.amount. The text is for people to
  // read: a key of a ComparisonSpec names a field, never a position.
  toString(): string {
    return `$${this.steps
      .map((step) =>
        typeof step === 'number' ? `[${step}]` : NameSelector.segment(step),
      )
      .join('')}`;
  }

  // The path without its item positions.
  get field(): Field {
    return new Field(
      this.steps.map((step) => (typeof step === 'number' ? Field.item : step)),
    );
  }
}
