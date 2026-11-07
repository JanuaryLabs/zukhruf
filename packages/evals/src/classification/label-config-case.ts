import type { CaseReader } from '../scoring/scorecard-scorer.ts';
import { LabelCase } from './label-case.ts';
import { readLabels } from './read-labels.ts';

// Reads a case from the config of an assertion: config.expected is a label
// or a list of labels. A case weighs 1 (Strategy).
export class LabelConfigCase implements CaseReader<LabelCase> {
  from(config: Readonly<Record<string, unknown>>): LabelCase {
    return new LabelCase({
      expected: readLabels(config['expected'], 'config.expected'),
      weight: 1,
    });
  }
}
