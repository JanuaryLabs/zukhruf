import { InvalidArgumentError } from 'ai';

import type { DecisionAnswer, DecisionInput } from './decision-model-v4.ts';
import type { Distribution } from './distribution.ts';
import { jsonText } from './json-text.ts';
import { Translation } from './translation.ts';

type Criteria = Readonly<Record<string, DecisionInput | null>>;

// Which criterion: an option for each criterion with a description. A
// criterion without a description is the abstention: its probability is the
// probability of "none", and it comes after the others, as in Venn
// (venn/decisions.py:108-111, 183-186). The choice is the first criterion
// with the largest probability, as np.argmax gives it
// (venn/decisions.py:208).
export class ChoiceTranslation extends Translation {
  // The name of each criterion, and the outcome of its probability.
  readonly #criteria: readonly (readonly [string, string])[];

  constructor(id: string, instructions: string, criteria: Criteria) {
    const described = Object.entries(criteria).filter(
      (entry): entry is [string, DecisionInput] => entry[1] !== null,
    );
    const abstentions = Object.keys(criteria).filter(
      (name) => criteria[name] === null,
    );
    if (described.length === 0 || abstentions.length > 1)
      throw new InvalidArgumentError({
        parameter: `questions.${id}.criteria`,
        value: criteria,
        message:
          'Choice questions require a criterion with a description, and accept one criterion without a description, the abstention, as Venn does.',
      });
    const options = described.map(([, description]) => jsonText(description));
    super(
      id,
      instructions,
      options,
      abstentions.length === 0 ? options : [...options, 'none'],
    );
    this.#criteria = [
      ...described.map(([name, description]): [string, string] => [
        name,
        jsonText(description),
      ]),
      ...abstentions.map((name): [string, string] => [name, 'none']),
    ];
  }

  protected complete(distribution: Distribution): DecisionAnswer {
    const probabilities = this.#criteria.map(
      ([name, outcome]): [string, number] => [
        name,
        distribution.probability(outcome),
      ],
    );
    const [choice] = probabilities.reduce((best, next) =>
      next[1] > best[1] ? next : best,
    );
    return {
      type: 'choice',
      choice,
      probabilities: Object.fromEntries(probabilities),
    };
  }
}
