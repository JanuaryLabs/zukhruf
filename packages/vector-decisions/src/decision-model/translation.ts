import { InvalidArgumentError } from 'ai';

import type { Answer, ChoiceQuestion } from '../service/decision.ts';
import type { DecisionAnswer } from './decision-model-v4.ts';
import { Distribution } from './distribution.ts';

// A question of the AI SDK as the Choice of DecisionService that Venn's
// Decisions API asks for it, and the answer of the Choice in the terms of
// the AI SDK (venn/decisions.py:67-128, 180-211). The text of each option
// is its label, so the texts must differ from each other and from "none",
// until the options have labels of their own (#4389).
export abstract class Translation {
  readonly question: ChoiceQuestion;
  readonly #outcomes: readonly string[];

  // `outcomes` are the labels of the probabilities of the answer: the
  // options, then "none" for a choice whose abstention is a criterion.
  constructor(
    id: string,
    instructions: string,
    options: readonly string[],
    outcomes: readonly string[] = options,
  ) {
    if (new Set(options).size !== options.length || options.includes('none'))
      throw new InvalidArgumentError({
        parameter: `questions.${id}.criteria`,
        value: options,
        message:
          'The descriptions of the criteria must differ from each other and from "none".',
      });
    this.question = { instructions, options };
    this.#outcomes = outcomes;
  }

  answer(choice: Answer | undefined): {
    readonly answer: DecisionAnswer;
    readonly none: number;
  } {
    const distribution = new Distribution(choice, this.#outcomes);
    return { answer: this.complete(distribution), none: distribution.none };
  }

  protected abstract complete(distribution: Distribution): DecisionAnswer;
}
