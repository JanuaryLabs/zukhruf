import type { Scorecard } from '../scoring/scorecard.ts';
import type { Scorer } from '../scoring/scorer.ts';
import type { JsonCase } from './json-case.ts';
import { statedValue } from './json-value.ts';

// Reads the text of a harness as json.loads would, without loss, and keeps
// the text when it is not JSON, as the runner of a benchmark does; then the
// scorer that it wraps scores the value (Decorator).
export class JsonTextScorer implements Scorer<JsonCase> {
  readonly #scorer: Scorer<JsonCase>;

  constructor(scorer: Scorer<JsonCase>) {
    this.#scorer = scorer;
  }

  score(stated: unknown, testCase: JsonCase): Scorecard {
    return this.#scorer.score(statedValue(stated), testCase);
  }
}
