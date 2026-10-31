import { type Experimental_DecisionModel, experimental_decide } from 'ai';

import type { Scorer, Stream } from './scorer.ts';
import { Scores, compareIds } from './scores.ts';

// The most calls to the model that one score keeps in flight. The server owns
// its capacity: llama.cpp gives itself 4 slots by default (--parallel -1, at
// b11960). Twice that keeps each slot fed while an answer travels back, so a
// slot does not wait on a round trip (docs/adr/0008).
const IN_FLIGHT = 8;

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

  async score(
    stream: Stream,
    { signal }: { readonly signal: AbortSignal },
  ): Promise<Scores> {
    signal.throwIfAborted();
    // The first failure stops the other calls, so a failed score asks the
    // model no more. A stop of the host aborts the same signal.
    const failed = new AbortController();
    const abortSignal = AbortSignal.any([signal, failed.signal]);
    // The workers share one iterator, so each article is asked once.
    const articles = stream.entries();
    const scored: {
      readonly id: string;
      readonly publishedAt: Date;
      readonly probability: number;
    }[] = [];
    const ask = async () => {
      try {
        for (const [id, { publishedAt, text }] of articles) {
          const { answers } = await experimental_decide({
            model: this.#model,
            abortSignal,
            state: text,
            questions: {
              relevant: { type: 'boolean', instructions: this.#instructions },
            },
          });
          scored.push({
            id,
            publishedAt,
            probability: answers.relevant.probability,
          });
        }
      } catch (error) {
        failed.abort(error);
        throw error;
      }
    };
    await Promise.all(Array.from({ length: IN_FLIGHT }, ask));
    // The answers arrive in any order; the ranking does not depend on it.
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
