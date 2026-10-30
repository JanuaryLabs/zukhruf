import { type Experimental_DecisionModel, experimental_decide } from 'ai';

import type { Profile } from './profile.ts';
import type { Scorer, Stream } from './scorer.ts';
import { Scores, compareIds } from './scores.ts';

// A decision model answers a typed question about a text with a calibrated
// probability, for example Liquid AI's d1-2B. Research rounds 13 and 14
// (#3383) found that its probability ranks better than the frozen
// similarity design, with no taught answer and no keyword (docs/adr/0005).
// The question is the one that round 13 asked, word for word.
export class DecisionScorer implements Scorer {
  readonly #model: Experimental_DecisionModel;

  constructor(options: { readonly model: Experimental_DecisionModel }) {
    this.#model = options.model;
  }

  async score(profile: Profile, stream: Stream): Promise<Scores> {
    const instructions = `Is the main subject of this article: ${profile.description}?`;
    const scored = await Array.fromAsync(
      stream,
      async ({ id, publishedAt, text }) => {
        const { answers } = await experimental_decide({
          model: this.#model,
          state: text,
          questions: { relevant: { type: 'boolean', instructions } },
        });
        return { id, publishedAt, probability: answers.relevant.probability };
      },
    );
    return new Scores({
      profile,
      ranked: scored.toSorted(
        (a, b) => b.probability - a.probability || compareIds(a.id, b.id),
      ),
    });
  }
}
