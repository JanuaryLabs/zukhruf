import { type Label, isLabel } from './label.ts';

// The expected labels of a plain object of a runner: a label or a list of
// labels.
export function readLabels(value: unknown, name: string): Label | Label[] {
  if (isLabel(value)) return value;
  if (Array.isArray(value) && value.every(isLabel)) return value;
  throw new Error(
    `${name} is a label (a number or a string) or a list of labels, not ${JSON.stringify(value)}`,
  );
}
