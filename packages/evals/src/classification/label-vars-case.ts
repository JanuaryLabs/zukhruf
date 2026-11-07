import type { CaseReader } from '../scoring/scorecard-scorer.ts';
import { LabelCase } from './label-case.ts';
import { readLabels } from './read-labels.ts';

// Reads a case from the vars of a test (Strategy): vars.expected is a label
// or a list of labels, and vars.weight is a number. A test without a weight
// weighs 1.
export class LabelVarsCase implements CaseReader<LabelCase> {
  from(vars: Readonly<Record<string, unknown>>): LabelCase {
    const { expected, weight } = vars;
    if (weight !== undefined && typeof weight !== 'number')
      throw new Error(`vars.weight is a number, not ${JSON.stringify(weight)}`);
    return new LabelCase({
      expected: readLabels(expected, 'vars.expected'),
      weight: weight ?? 1,
    });
  }
}
