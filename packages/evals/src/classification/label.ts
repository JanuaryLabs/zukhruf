import { compareStrings } from '@zukhruf/python';

// A label of a class: a number or a string, as scikit-learn reads a label.
export type Label = number | string;

// Is the value a label: a finite number or a string.
export function isLabel(value: unknown): value is Label {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

// The order of numpy's unique() of labels: numbers by value, strings by code
// point. scikit-learn refuses a mix of numbers and strings.
export function compareLabels(left: Label, right: Label): number {
  if (typeof left === 'number' && typeof right === 'number')
    return left - right;
  if (typeof left === 'string' && typeof right === 'string')
    return compareStrings(left, right);
  throw new TypeError(
    `The labels ${JSON.stringify(left)} and ${JSON.stringify(right)} mix a number and a string, which scikit-learn refuses.`,
  );
}
