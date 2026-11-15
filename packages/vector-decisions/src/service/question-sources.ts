import { ContractError } from './contract-error.ts';
import type { OptionQuestion } from './decision.ts';
import type { Source, Vectors } from './vectors.ts';

const MAX_OPTIONS = 256;
const DEFAULT_INSTRUCTIONS = 'What is the topic?';

// The instructions, the options and the labels of a question, after the
// checks of Venn's prepared_question, in Venn's order
// (venn/server.py:816-828).
export class QuestionSources {
  readonly instructions: Source;
  readonly options: readonly Source[];
  readonly labels: readonly string[];

  constructor(question: OptionQuestion, vectors: Vectors) {
    const { options } = question;
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
  }
}
