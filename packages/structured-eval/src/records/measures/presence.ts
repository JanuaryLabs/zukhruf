import type { Leaf } from '../record-visitor.ts';
import { hasValue } from '../values.ts';
import { FieldHits } from './field-hits.ts';

// The present values: both records have a value at the path, the same value
// or not.
export class Presence extends FieldHits {
  protected readonly label = 'presence ';

  protected hit(leaf: Leaf): boolean {
    return hasValue(leaf.expected) && hasValue(leaf.stated);
  }
}
