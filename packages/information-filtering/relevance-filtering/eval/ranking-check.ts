import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EVAL_FOLDER } from './answer-key.ts';
import { descriptionVectors } from './cache.ts';
import { joined } from './design.ts';
import { readProfiles } from './profiles.ts';
import { poolOf, runRankingUnit, streamOf } from './ranking.ts';
import { LoadedSet } from './slice.ts';

export type RankingCheck = {
  // The order of the research on float64 vectors and on the vectors as a
  // collection stores them: the package must give each one.
  readonly float64: {
    readonly same: boolean;
    readonly firstDifference: number;
  };
  readonly float32: {
    readonly same: boolean;
    readonly firstDifference: number;
  };
  readonly articles: number;
};

// The ranking check of freeze-ranking/plan.json: the order of desc+kw for
// profile security, the pool protocol of round 10 and N = 10, through the
// package, against the order of the research code
// (implementation-check/ranking-reference.json).
export function rankingCheck(): RankingCheck {
  const profile = readProfiles().find(({ id }) => id === 'security');
  const descriptionVector = descriptionVectors().get('security');
  if (profile === undefined || descriptionVector === undefined)
    throw new Error(
      'The profile security or its description vector is missing.',
    );
  using stack = new DisposableStack();
  const pool = ['collection', 'fresh', 'fresh-2'].map((name) =>
    stack.use(new LoadedSet(name)),
  );
  const slice = stack.use(new LoadedSet('fresh-3'));
  const unit = runRankingUnit({
    profile,
    pool: poolOf(pool, profile, descriptionVector),
    n: 10,
    stream: streamOf(slice, profile),
    vectors: joined(
      slice.collection,
      pool.map(({ collection }) => collection),
    ),
    descriptionVector,
    textOf: (id) =>
      [slice, ...pool].find(({ texts }) => texts.has(id))?.textOf(id) ?? '',
  });
  const reference: { float64: string[]; float32: string[] } = JSON.parse(
    readFileSync(
      join(EVAL_FOLDER, 'implementation-check', 'ranking-reference.json'),
      'utf8',
    ),
  );
  const order = unit.orders['desc+kw'];
  const compare = (expected: readonly string[]) => {
    const firstDifference = expected.findIndex(
      (id, index) => order[index] !== id,
    );
    return {
      same: firstDifference === -1 && expected.length === order.length,
      firstDifference,
    };
  };
  return {
    float64: compare(reference.float64),
    float32: compare(reference.float32),
    articles: order.length,
  };
}
