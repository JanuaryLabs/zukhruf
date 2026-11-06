import type { JsonPair } from './json-pair.ts';

// One value for one stated value and its case, such as the share of the
// expected leaves that the stated value has with an equal value. A gate is a
// scorer whose value is 0 or 1.
export interface Scorer {
  score(pair: JsonPair): number;
}
