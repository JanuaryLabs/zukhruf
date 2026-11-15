import { Choice } from './choice.ts';
import { ContractError } from './contract-error.ts';
import type { Question } from './decision.ts';
import { IndexApply } from './index-apply.ts';
import { Noul } from './noul.ts';
import type { QuestionKind } from './question-kind.ts';
import { QuestionSources } from './question-sources.ts';
import { Score } from './score.ts';
import type { StateVectors, Vectors } from './vectors.ts';

// One question about the state, after Venn's checks of it, in Venn's order
// (venn/server.py:963, 1043, 816-828, 1064-1071, 1092, 1103-1105): the
// sources of its instructions and options, its labels, and the kind that
// answers it.
export class CheckedQuestion {
  readonly sources: QuestionSources;
  readonly kind: QuestionKind;

  constructor(
    question: Question,
    state: StateVectors,
    vectors: Vectors,
    temperature: number,
    choiceTemperature: number,
  ) {
    const { threshold } = question;
    if (threshold !== undefined && !(threshold >= 0 && threshold <= 1))
      throw new ContractError('threshold', 'Threshold must be in [0,1]');
    const kind = CheckedQuestion.#kind(
      question,
      temperature,
      choiceTemperature,
    );
    this.sources = new QuestionSources(question, vectors);
    this.kind = kind(this.sources.labels, state);
  }

  // The kind of the question by its type. The kind is made when the labels
  // are known: it checks the state first, then a Score checks its scores
  // against the labels.
  static #kind(
    question: Question,
    temperature: number,
    choiceTemperature: number,
  ): (labels: readonly string[], state: StateVectors) => QuestionKind {
    const { type, threshold } = question;
    switch (type) {
      case undefined:
      case 'Choice':
        return (_, state) =>
          new Choice(
            threshold,
            temperature,
            CheckedQuestion.#one(state, 'Choice'),
          );
      case 'Score': {
        const { scores } = question;
        return (labels, state) => {
          const one = CheckedQuestion.#one(state, type);
          return new Score(
            threshold,
            temperature,
            one,
            CheckedQuestion.#scores(scores, labels),
          );
        };
      }
      case 'Noul':
        return (_, state) =>
          new Noul(
            threshold,
            temperature,
            choiceTemperature,
            CheckedQuestion.#one(state, type),
          );
      case 'IndexApply': {
        const { rowCap, batchSize } = question;
        return (_, state) =>
          new IndexApply(
            threshold,
            temperature,
            CheckedQuestion.#rows(state),
            rowCap,
            batchSize,
          );
      }
      default:
        throw new ContractError(
          'question_type',
          `Unsupported question type ${String(type)}`,
        );
    }
  }

  static #one(state: StateVectors, type: string): Float32Array {
    if ('rows' in state)
      throw new ContractError(
        'unsupported_input',
        `${type} answers one state; ask an IndexApply question to answer each row of a plural state`,
      );
    return state.vector;
  }

  static #rows(state: StateVectors): readonly Float32Array[] {
    if ('vector' in state)
      throw new ContractError(
        'index_input',
        'IndexApply requires multiple rows',
      );
    return state.rows;
  }

  // One finite score for each label; the default is 0, 1, 2 and so on.
  static #scores(
    scores: readonly number[] | undefined,
    labels: readonly string[],
  ): readonly number[] {
    const checked = scores ?? labels.map((_, index) => index);
    if (checked.length !== labels.length || !checked.every(Number.isFinite))
      throw new ContractError(
        'rubric',
        'Finite scores must match ordered rubric',
      );
    return checked;
  }
}
