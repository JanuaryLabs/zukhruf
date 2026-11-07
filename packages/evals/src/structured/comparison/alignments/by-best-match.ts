import { munkres } from 'munkres';

import type { JsonData } from '@zukhruf/python';

import type { Agreement, Alignment, Pairs } from '../alignment.ts';
import type { Match } from '../match.ts';

// A set array: of all pairings, the one with the most agreeing leaves (the
// Hungarian algorithm, ADR 0002). A pair that the match forbids is no pair.
// Without a match, a pair that agrees on nothing is no pair; with a match,
// the match alone makes a pair.
export class ByBestMatch implements Alignment {
  readonly #match: Match | undefined;

  constructor(match?: Match) {
    this.#match = match;
  }

  pairs(
    stated: readonly JsonData[],
    expected: readonly JsonData[],
    agreement: Agreement,
  ): Pairs {
    if (stated.length === 0 || expected.length === 0) return [];
    const weights = stated.map((statedItem) =>
      expected.map((expectedItem) =>
        this.#weight(statedItem, expectedItem, agreement),
      ),
    );
    return munkres(
      weights.map((row) => row.map((weight) => -weight)),
      { finite: true },
    ).filter(([row, column]) => (weights[row]?.[column] ?? 0) > 0);
  }

  #weight(stated: JsonData, expected: JsonData, agreement: Agreement) {
    if (this.#match === undefined) return agreement.count(stated, expected);
    return this.#match.canPair(stated, expected)
      ? agreement.count(stated, expected) + 1
      : 0;
  }
}
