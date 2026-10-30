import { type Experimental_DecisionModel, experimental_decide } from 'ai';

import type { Scorer, Stream } from './scorer.ts';
import { Scores, compareIds } from './scores.ts';

// A decision model answers a typed question about a text with a calibrated
// probability, for example Liquid AI's d1-2B. Research rounds 13 and 14
// (#3383) found that its probability ranks better than the frozen
// similarity design, with no taught answer and no keyword (docs/adr/0005).
// The question is the one that round 13 asked, word for word.
export class DecisionScorer implements Scorer {
  readonly #model: Experimental_DecisionModel;
  readonly #instructions: string;

  constructor(options: {
    readonly model: Experimental_DecisionModel;
    // One sentence that says what the reader wants to read.
    readonly description: string;
  }) {
    this.#model = options.model;
    this.#instructions = `Is the main subject of this article: ${options.description}?`;
  }

  async score(stream: Stream): Promise<Scores> {
    const scored = await Array.fromAsync(
      stream,
      async ([id, { publishedAt, text }]) => {
        const { answers } = await experimental_decide({
          model: this.#model,
          state: text,
          questions: {
            relevant: { type: 'boolean', instructions: this.#instructions },
          },
        });
        return { id, publishedAt, probability: answers.relevant.probability };
      },
    );
    return new Scores(
      new Map(
        scored
          .toSorted(
            (a, b) => b.probability - a.probability || compareIds(a.id, b.id),
          )
          .map(({ id, publishedAt, probability }) => [
            id,
            { publishedAt, probability },
          ]),
      ),
    );
  }
}
