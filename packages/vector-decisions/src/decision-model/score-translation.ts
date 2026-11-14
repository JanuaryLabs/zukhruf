import { InvalidArgumentError } from 'ai';

import type { DecisionAnswer, DecisionInput } from './decision-model-v4.ts';
import type { Distribution } from './distribution.ts';
import { jsonText } from './json-text.ts';
import { Translation } from './translation.ts';

// Which level of a scale: an option for each level, in order. The score is
// the sum of each probability times its level from zero, and the
// probabilities are by level (venn/decisions.py:199-204). Venn refuses a
// level without a description (venn/decisions.py:109).
export class ScoreTranslation extends Translation {
  readonly #levels: readonly string[];

  constructor(
    id: string,
    instructions: string,
    levels: readonly (DecisionInput | null)[],
  ) {
    const texts = ScoreTranslation.#texts(id, levels);
    super(id, instructions, texts);
    this.#levels = texts;
  }

  protected complete(distribution: Distribution): DecisionAnswer {
    const probabilities = this.#levels.map((level) =>
      distribution.probability(level),
    );
    return {
      type: 'score',
      score: probabilities.reduce(
        (sum, probability, level) => sum + probability * level,
        0,
      ),
      probabilities: Object.fromEntries(
        probabilities.map((probability, level) => [String(level), probability]),
      ),
    };
  }

  static #texts(
    id: string,
    levels: readonly (DecisionInput | null)[],
  ): readonly string[] {
    return levels.map((level) => {
      if (level === null)
        throw new InvalidArgumentError({
          parameter: `questions.${id}.criteria`,
          value: levels,
          message:
            'Score questions require a description of each level, as Venn does.',
        });
      return jsonText(level);
    });
  }
}
