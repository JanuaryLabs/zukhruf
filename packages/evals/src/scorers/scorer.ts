import type { Ratio } from '../aggregation/ratio.ts';

// One Ratio for one input, such as the expected leaves that the stated value
// has with an equal value, of all expected leaves. A gate is a scorer whose
// ratio is 1 of 1 or 0 of 1.
export interface Scorer<Input> {
  score(input: Input): Ratio;
}
