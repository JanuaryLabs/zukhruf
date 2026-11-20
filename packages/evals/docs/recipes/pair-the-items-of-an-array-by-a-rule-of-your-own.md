# Recipe: Pair the items of an array by a rule of your own

**Use case.** An answer states the offers of a web page, and the label of the page gives the expected offers. The offers have no order, so the array is a set array, and `ByBestMatch` pairs its items. Without a match, `ByBestMatch` pairs two items when their leaves agree. A stated offer can then pair with an expected offer because its amount is the same, also when it quotes another sentence of the page, such as a referral bonus. Item precision and item recall count that pair as a hit. A match is your rule that says if two items can be a pair. Two consumers write their own: startup-credits has `SameSentence` (`context-compiler/apps/startup-credits/promptfoo/assertions/offers.ts`), and ipay has `sameLine` and `sameLineExact` (`offers-evals/apps/ipay/src/scores/pairing.ts`).

**What you need.** A class or an object that implements `Match`, and `ByBestMatch`, `ComparisonSpec`, `TreeWalk` and `ItemMatches` of `@zukhruf/evals/structured`. `toJsonParseValue` of `@zukhruf/python` reads the items as plain JavaScript.

## The steps

1. Write a `Match` with one method, `canPair(stated, expected)`. It gets the stated item first and the expected item second, as `JsonData`.
2. Give the match to the alignment of the array: `arrays: { '$.offers': new ByBestMatch(match) }`.
3. Exclude the fields that only the match reads, such as the quote and the mentions.
4. Compare the answer with its case through `new TreeWalk(spec)`, and score the comparison with `new Precision(new ItemMatches())` and `new Recall(new ItemMatches())`.

## The program

The program compares one answer with its label two times: once with `ByBestMatch` and no match, and once with the match `SameSentence`. For each spec, it prints the item pairs and three ratios.

```ts title="same-sentence.ts"
import { Precision, Recall } from '@zukhruf/evals';
import {
  ByBestMatch,
  ComparisonSpec,
  ConfigCase,
  ItemMatches,
  type Match,
  TreeWalk,
  ValueMatches,
} from '@zukhruf/evals/structured';
import { type JsonData, toJsonParseValue } from '@zukhruf/python';

// A stated offer and an expected offer are one offer when the quote of the
// stated offer is one of the sentences that the label marks. The walk gives
// JSON data, whose objects are Maps, so the rule reads them as JSON.parse
// would give them.
class SameSentence implements Match {
  canPair(stated: JsonData, expected: JsonData): boolean {
    const offer = toJsonParseValue(stated);
    const label = toJsonParseValue(expected);
    if (typeof offer !== 'object' || offer === null || Array.isArray(offer))
      return false;
    if (typeof label !== 'object' || label === null || Array.isArray(label))
      return false;
    const { quote } = offer;
    const { mentions } = label;
    return (
      typeof quote === 'string' &&
      Array.isArray(mentions) &&
      mentions.includes(quote)
    );
  }
}

// The label of one page: two offers, each with the sentences that state it.
const testCase = new ConfigCase().from({
  expected: {
    offers: [
      { amount: 5000, mentions: ['Get $5,000 in cloud credits.'] },
      { amount: 1000, mentions: ['Startups get $1,000 off the first year.'] },
    ],
  },
});

// The answer: the first offer is right. The second offer has the amount of
// the second label, but its quote is a referral bonus, not an offer.
const answer = {
  offers: [
    { amount: 5000, quote: 'Get $5,000 in cloud credits.' },
    { amount: 1000, quote: 'Refer a friend and get $1,000.' },
  ],
};

// The quote and the mentions are text of the page, so the walk does not
// compare them as leaves. Only the match reads them.
const exclude = ['$.offers[*].quote', '$.offers[*].mentions'];
const specs = {
  'by leaves': new ComparisonSpec({
    arrays: { '$.offers': new ByBestMatch() },
    exclude,
  }),
  'by same sentence': new ComparisonSpec({
    arrays: { '$.offers': new ByBestMatch(new SameSentence()) },
    exclude,
  }),
};

const itemPrecision = new Precision(new ItemMatches());
const itemRecall = new Recall(new ItemMatches());
const valueRecall = new Recall(new ValueMatches());

for (const [name, spec] of Object.entries(specs)) {
  const comparison = new TreeWalk(spec).compare(answer, testCase);
  console.log(`${name}:`);
  for (const offers of comparison.arrays()) {
    for (const { stated, expected } of offers.pairs)
      console.log(`  pair ${stated.path} with ${expected.path}`);
    for (const item of offers.unpairedStated)
      console.log(`  no pair for stated ${item.path}`);
    for (const item of offers.unpairedExpected)
      console.log(`  no pair for expected ${item.path}`);
  }
  for (const [label, scorer] of [
    ['item precision', itemPrecision],
    ['item recall', itemRecall],
    ['value recall', valueRecall],
  ] as const) {
    const { part, whole } = scorer.score(comparison);
    console.log(`  ${label}: ${part} of ${whole}`);
  }
}
```

Output:

```
by leaves:
  pair $.offers[0] with $.offers[0]
  pair $.offers[1] with $.offers[1]
  item precision: 2 of 2
  item recall: 2 of 2
  value recall: 2 of 2
by same sentence:
  pair $.offers[0] with $.offers[0]
  no pair for stated $.offers[1]
  no pair for expected $.offers[1]
  item precision: 1 of 2
  item recall: 1 of 2
  value recall: 1 of 2
```

## What the output shows

- **Without a match, the leaves make the pairs.** The second stated offer has the amount 1000, the same as the second expected offer. So `ByBestMatch` pairs them, and item precision and item recall are 2 of 2. The answer gets credit for an offer that the page does not state.
- **With the match, the referral bonus has no pair.** Its quote is not a sentence of the second label, so `SameSentence` forbids the pair. The two items stay without a pair, and each ratio is 1 of 2.
- **The match also changes the leaf scores.** The leaves of an item without a pair have no other side. With the match, the amount of the second expected offer has no stated side, so value recall is 1 of 2.

## Things to know

- **A match forbids a pair; it does not choose one.** Of the pairs that the match allows, `ByBestMatch` takes the pairing with the most agreeing leaves (the Hungarian algorithm, [ADR 0002 of `./structured`](../adr/structured/0002-set-items-pair-by-maximum-matching-and-the-metrics-are-micro-averages.md), `src/structured/comparison/alignments/by-best-match.ts`).
- **With a match, the match alone makes a pair.** A pair that the match allows is a pair also when no leaf agrees. Without a match, a pair that agrees on nothing is no pair (`src/structured/comparison/alignments/by-best-match.ts`).
- **The match reads JSON data.** An object is a `Map`, and an integer is a `bigint`. A pair that the match forbids leaves both items without a pair, even when their leaves agree (`src/structured/comparison/comparison-spec.test.ts`). Read the items through `toJsonParseValue`. The two consumers then check the plain value with a zod schema.
- **A match can be a plain object.** `Match` is an interface, so ipay writes `sameLine` as an object with a `canPair` method (`offers-evals/apps/ipay/src/scores/pairing.ts`).
- **A match can build on another match.** ipay's `sameLineExact` first asks `sameLine`, then compares the company with `NormalizedText` and the amount and the currency with `JsonEquality`. Its `exact_precision` score is `new Penalized(new Precision(new ItemMatches()), new SchemaCompliance())` over that pairing (`offers-evals/apps/ipay/src/scores/exact-precision.ts`).
- **Each array has its own alignment.** An array that the spec does not name pairs by position ([Compare two values](../structured.md#compare-two-values)).
