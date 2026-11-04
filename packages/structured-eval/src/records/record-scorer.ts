import type { Scorecard } from '../scoring/scorecard.ts';
import type { Scorer } from '../scoring/scorer.ts';
import { Correctness } from './measures/correctness.ts';
import { Differences } from './measures/differences.ts';
import { ItemPairing } from './measures/item-pairing.ts';
import { Presence } from './measures/presence.ts';
import { TokenCredit } from './measures/token-credit.ts';
import type { RecordCase } from './record-case.ts';
import { RecordLeaves } from './record-leaves.ts';
import type { RecordSpec } from './record-spec.ts';
import { RecordWalk } from './record-walk.ts';

// Compares a stated record with the expected record of its case, as the spec
// says. It makes new measures for each record and keeps no result.
export class RecordScorer implements Scorer<RecordCase> {
  readonly #spec: RecordSpec;
  readonly #walk: RecordWalk;
  readonly #leaves: RecordLeaves;

  constructor(spec: RecordSpec) {
    this.#spec = spec;
    this.#walk = new RecordWalk(spec);
    this.#leaves = new RecordLeaves(spec);
  }

  score(stated: unknown, testCase: RecordCase): Scorecard {
    const schema = this.#spec.schema.measure(stated, this.#leaves);
    const correctness = new Correctness();
    const presence = new Presence();
    const tokens = new TokenCredit();
    const items = new ItemPairing();
    const differences = new Differences();
    // An invalid record counts as a record that stated nothing, so its
    // expected values stay in the denominators.
    this.#walk.visit(schema.valid ? stated : undefined, testCase.expected, [
      correctness,
      presence,
      tokens,
      items,
      differences,
    ]);
    const passed = schema.valid && items.allPaired && differences.none;
    return {
      passed,
      score: passed ? 1 : correctness.f1,
      reason: passed
        ? 'every field is right and every item has a pair'
        : [schema.reason, ...items.unpaired(), ...differences.lines()]
            .filter((line) => line !== '')
            .join('; '),
      ratios: new Map([
        ...correctness.ratios(),
        ...presence.ratios(),
        ...tokens.ratios(),
        ...items.ratios(),
        ...schema.ratios(),
      ]),
      checks: correctness.checks(),
    };
  }
}
