import { Choice } from './choice.ts';
import { ContractError } from './contract-error.ts';
import type { Question } from './decision.ts';
import { Noul } from './noul.ts';
import type { QuestionKind } from './question-kind.ts';
import { Score } from './score.ts';
import type { Source, StateVectors, Vectors } from './vectors.ts';

const MAX_OPTIONS = 256;
const DEFAULT_INSTRUCTIONS = 'What is the topic?';

// One question about one state, after Venn's checks of it, in Venn's order
// (venn/server.py:963, 1043, 816-828, 1092, 1103-1105): the kind that
// answers it, the vectors of its instructions and options, its labels, and
// the vector of the state.
export class CheckedQuestion {
  readonly kind: QuestionKind;
  readonly instructions: Source;
  readonly options: readonly Source[];
  readonly labels: readonly string[];
  readonly state: Float32Array;

  constructor(
    question: Question,
    state: StateVectors,
    vectors: Vectors,
    temperature: number,
  ) {
    const { threshold, options } = question;
    if (threshold !== undefined && !(threshold >= 0 && threshold <= 1))
      throw new ContractError('threshold', 'Threshold must be in [0,1]');
    const kind = CheckedQuestion.#kind(question, temperature);
    this.instructions = vectors.source(
      question.instructionsVec ?? question.instructions ?? DEFAULT_INSTRUCTIONS,
    );
    if (options.length < 1 || options.length > MAX_OPTIONS)
      throw new ContractError(
        'option_limit',
        `Provide 1..${MAX_OPTIONS} options`,
      );
    // An option without a vector is the text of its label.
    this.options = options.map((option) =>
      vectors.source(
        typeof option === 'string' ? option : (option.vector ?? option.label),
      ),
    );
    this.labels = options.map((option) =>
      typeof option === 'string' ? option : option.label,
    );
    if (
      new Set(this.labels).size !== this.labels.length ||
      this.labels.includes('none')
    )
      throw new ContractError(
        'option_labels',
        'Option labels must be distinct and cannot be none',
      );
    if (state.from === 'texts')
      throw new ContractError(
        'unsupported_input',
        `${question.type ?? 'Choice'} answers one state`,
      );
    this.state = state.vector;
    this.kind = kind(this.labels);
  }

  // The kind of the question by its type. The kind is made when the labels
  // are known, because a Score checks its scores against them.
  static #kind(
    question: Question,
    temperature: number,
  ): (labels: readonly string[]) => QuestionKind {
    const { type, threshold } = question;
    switch (type) {
      case undefined:
      case 'Choice':
        return () => new Choice(threshold, temperature);
      case 'Score': {
        const { scores } = question;
        return (labels) =>
          new Score(
            threshold,
            temperature,
            CheckedQuestion.#scores(scores, labels),
          );
      }
      case 'Noul':
        return () => new Noul(threshold, temperature);
      default:
        throw new ContractError(
          'question_type',
          `Unsupported question type ${String(type)}`,
        );
    }
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
