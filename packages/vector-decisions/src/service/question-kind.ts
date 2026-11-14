import type { PreparedQuestion } from '../head/prepared-question.ts';
import type { Answer } from './decision.ts';

// The way a type of question answers from its prepared question: Choice,
// Score and Noul about one state, IndexApply about each row of a plural
// state.
export interface QuestionKind {
  answer(prepared: PreparedQuestion, labels: readonly string[]): Answer;
}
