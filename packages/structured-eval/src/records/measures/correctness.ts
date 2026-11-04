import type { Check } from '../../scoring/scorecard.ts';
import type { Leaf } from '../record-visitor.ts';
import { FieldHits } from './field-hits.ts';

// The right values: both records have a value, and the comparator of the
// field agrees.
export class Correctness extends FieldHits {
  protected readonly label = '';

  protected hit(leaf: Leaf): boolean {
    return leaf.agrees;
  }

  get f1(): number {
    return this.total.f1.value;
  }

  checks(): Check[] {
    return [...this.fields].map(([field, counts]) => ({
      name: field,
      passed: counts.complete,
      score: counts.f1.value,
      reason: `${field}: ${counts.hits} right of ${counts.expected} expected and ${counts.stated} stated`,
    }));
  }
}
