import type { ChoiceAnswer } from './decision.ts';
import { OneStateKind } from './one-state-kind.ts';

// Which option: one softmax over the logits of the options and of "none"
// (venn/server.py:1097).
export class Choice extends OneStateKind<ChoiceAnswer> {
  protected probabilities(logits: Float64Array): Float64Array {
    return OneStateKind.softmax(logits, this.temperature);
  }

  protected complete(
    answer: ChoiceAnswer,
    probabilities: Float64Array,
  ): ChoiceAnswer {
    return answer;
  }
}
