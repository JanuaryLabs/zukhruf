import { NameSelector } from './name-selector.ts';

// A step of a field: a key of an object, or an item of an array at any
// position.
export type FieldStep = string | typeof Field.item;

// A path without its item positions, such as offers, an item, value, amount
// (written $.offers[*].value.amount). A field is its steps, as a path is, so a
// property named "a.b" and the property b of a are different fields.
export class Field {
  static readonly item: unique symbol = Symbol('an item of an array');

  readonly steps: readonly FieldStep[];
  // The identity of the field: two fields with the same steps have the same
  // id. A key is a JSON string and an item is 0, so no two step lists share an
  // id.
  readonly id: string;

  constructor(steps: readonly FieldStep[]) {
    this.steps = steps;
    this.id = JSON.stringify(
      steps.map((step) => (step === Field.item ? 0 : step)),
    );
  }

  // The field as a JSONPath query (RFC 9535), as a key of a ComparisonSpec
  // writes it: the wildcard selector for an item, such as
  // $.offers[*].value.amount, and a bracketed name selector for a key that is
  // not a member-name-shorthand, such as $['a.b'].
  toString(): string {
    return `$${this.steps
      .map((step) => (step === Field.item ? '[*]' : NameSelector.segment(step)))
      .join('')}`;
  }

  child(step: FieldStep): Field {
    return new Field([...this.steps, step]);
  }
}
