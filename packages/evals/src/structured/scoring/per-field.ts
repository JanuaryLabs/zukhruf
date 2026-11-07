import { Grouped } from '../../scoring/grouped.ts';
import type { Comparison } from '../comparison/comparison.ts';

// A scorer for each field of a comparison: in a ScorerSet, it gives the
// ratio of its scorer on the leaf pairs and item pairs of each field, under
// the label `${field} ${label}`, such as `$.offers[*].kind recall`. A field
// gives no ratio when the scorer counts nothing in it: an object or an array
// under a scorer of leaves, or a field whose leaves are all null under
// nullIsMissing.
export class PerField extends Grouped<Comparison> {
  protected *groups(comparison: Comparison): Iterable<[string, Comparison]> {
    for (const field of comparison.fields())
      yield [`${field}`, comparison.only(field)];
  }
}
