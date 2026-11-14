import { type Experimental_DecisionQuestion, InvalidArgumentError } from 'ai';

import type { DecisionAnswer } from './decision-model-v4.ts';
import type { Distribution } from './distribution.ts';
import { jsonText } from './json-text.ts';
import { Translation } from './translation.ts';

type Criteria = Extract<
  Experimental_DecisionQuestion,
  { readonly type: 'boolean' }
>['criteria'];

// Is it true: two options, the descriptions of false and of true, which are
// "No. " and "Yes. " before the instructions when the question has no
// criteria. The answer is the probability of true (venn/decisions.py:95-99,
// 198). Venn refuses criteria without both descriptions.
export class BooleanTranslation extends Translation {
  readonly #true: string;

  constructor(id: string, instructions: string, criteria: Criteria) {
    const options = BooleanTranslation.#texts(id, instructions, criteria);
    super(id, instructions, options);
    this.#true = options[1];
  }

  protected complete(distribution: Distribution): DecisionAnswer {
    return {
      type: 'boolean',
      probability: distribution.probability(this.#true),
    };
  }

  static #texts(
    id: string,
    instructions: string,
    criteria: Criteria,
  ): readonly [string, string] {
    if (criteria === undefined)
      return [`No. ${instructions}`, `Yes. ${instructions}`];
    const { false: no, true: yes } = criteria;
    if (no === undefined || no === null || yes === undefined || yes === null)
      throw new InvalidArgumentError({
        parameter: `questions.${id}.criteria`,
        value: criteria,
        message:
          'Boolean questions require descriptions of both true and false, or none, as Venn does.',
      });
    return [jsonText(no), jsonText(yes)];
  }
}
