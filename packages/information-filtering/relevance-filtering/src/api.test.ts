import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Experimental_DecisionModel } from 'ai';

import * as api from './index.ts';
import {
  DecisionScorer,
  KeywordScorer,
  SimilarityScorer,
  type Vectors,
} from './index.ts';

describe('the API', () => {
  test('makes illegal inputs fail the type check: answers that were not parsed, no keyword for cold start, and a stream that can repeat an id', () => {
    // A function that is never called: the type checker reads it.
    const illegal = (vectors: Vectors, model: Experimental_DecisionModel) => [
      new SimilarityScorer({
        vectors,
        descriptionVector: [1, 0],
        // @ts-expect-error answers that were not parsed can hold no yes (#3383).
        answers: new Map([['a', { relevant: false, text: 'A' }]]),
        keywords: [],
      }),
      // @ts-expect-error cold start needs at least one keyword (#3383).
      new KeywordScorer({ vectors, descriptionVector: [1, 0], keywords: [] }),
      new DecisionScorer({ model, description: 'Chips.' }).score(
        // @ts-expect-error a stream is a map by id, so no id repeats (#3383).
        [{ id: 'a', publishedAt: new Date(), text: 'A' }],
      ),
    ];
    assert.equal(typeof illegal, 'function');
  });

  test('has no profile and none of the errors that the types now rule out', () => {
    for (const name of ['Profile', 'ConflictingAnswerError', 'NoEvidenceError'])
      assert.equal(name in api, false, name);
  });
});
