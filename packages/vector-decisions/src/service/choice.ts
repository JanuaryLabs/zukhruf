import type { Answer, ChoiceAnswer } from './decision.ts';
import { QuestionKind } from './question-kind.ts';

// Which option: one softmax over the logits of the options and of "none"
// (venn/server.py:1097).
export class Choice extends QuestionKind {
  protected probabilities(logits: Float64Array): Float64Array {
    return QuestionKind.softmax(logits, this.temperature);
  }

  protected complete(
    answer: ChoiceAnswer,
    probabilities: Float64Array,
  ): Answer {
    return answer;
  }
}
