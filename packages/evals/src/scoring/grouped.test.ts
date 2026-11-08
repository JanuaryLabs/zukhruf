import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Grouped, Precision, Ratio, type Scorer, ScorerSet } from '../index.ts';
import {
  type Comparison,
  ConfigCase,
  ItemMatches,
  TreeWalk,
} from '../structured/index.ts';

// A breakdown whose group is a projection of the input, not the input: for
// each kind of a closed list, the stated items of that kind without a pair,
// over all stated items. startup-credits explains its false alarms this way
// (#3882), so a record with no false alarm still gives a 0 for each kind.
type Share = { readonly part: number; readonly whole: number };

const falseAlarmKinds = ['support', 'discount'];

class UnpairedByKind extends Grouped<Comparison, Share> {
  protected *groups(comparison: Comparison): Iterable<[string, Share]> {
    for (const items of comparison.arrays())
      for (const kind of falseAlarmKinds) {
        const unpaired = items.unpairedStated.filter(
          ({ value }) => value instanceof Map && value.get('kind') === kind,
        );
        yield [kind, { part: unpaired.length, whole: items.stated }];
      }
  }
}

const share: Scorer<Share> = {
  score: ({ part, whole }) => new Ratio(part, whole),
};

test('a Grouped whose group is a projection of the input gives one ratio for each group, under "<group> <label>"', () => {
  const scorer = new ScorerSet(
    {
      items: new Precision(new ItemMatches()),
      'false alarms': new UnpairedByKind(share),
    },
    { comparer: new TreeWalk() },
  );

  const scorecard = scorer.score(
    {
      offers: [
        { kind: 'credits' },
        { kind: 'support' },
        { kind: 'support' },
        { kind: 'discount' },
      ],
    },
    new ConfigCase().from({ expected: { offers: [{ kind: 'credits' }] } }),
  );

  assert.deepEqual(
    [...scorecard.ratios],
    [
      ['items', new Ratio(1, 4)],
      ['support false alarms', new Ratio(2, 4)],
      ['discount false alarms', new Ratio(1, 4)],
    ],
  );
});

test('the score of a record is the mean of its plain scorers: a Grouped breakdown stays out of it', () => {
  const scorer = new ScorerSet(
    {
      items: new Precision(new ItemMatches()),
      'false alarms': new UnpairedByKind(share),
    },
    { comparer: new TreeWalk() },
  );

  const perfect = scorer.score(
    { offers: [{ kind: 'credits' }] },
    new ConfigCase().from({ expected: { offers: [{ kind: 'credits' }] } }),
  );
  const extra = scorer.score(
    { offers: [{ kind: 'credits' }, { kind: 'support' }] },
    new ConfigCase().from({ expected: { offers: [{ kind: 'credits' }] } }),
  );

  assert.deepEqual(
    [...perfect.ratios],
    [
      ['items', new Ratio(1, 1)],
      ['support false alarms', new Ratio(0, 1)],
      ['discount false alarms', new Ratio(0, 1)],
    ],
  );
  assert.equal(perfect.score, 1);
  assert.deepEqual(
    [...extra.ratios],
    [
      ['items', new Ratio(1, 2)],
      ['support false alarms', new Ratio(1, 2)],
      ['discount false alarms', new Ratio(0, 2)],
    ],
  );
  assert.equal(extra.score, 0.5);
});
