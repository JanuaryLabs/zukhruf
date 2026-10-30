import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ExpectedFThreshold } from '../src/index.ts';
import { EVAL_FOLDER } from './answer-key.ts';
import { descriptionVectors } from './cache.ts';
import { runDesign } from './design.ts';
import { readProfiles } from './profiles.ts';
import { LoadedSet } from './slice.ts';
import { type Candidate, teach } from './teaching.ts';
import { scoredStream, windowOf } from './units.ts';

// The record that the package must reproduce (freeze/plan.json,
// implementationCheck): profile security, slice fresh, product teaching with
// N = 10.
export type CheckRecord = {
  readonly shownIds: readonly string[];
  readonly taughtRelevant: readonly string[];
  readonly taughtNotRelevant: readonly string[];
  readonly threshold: number;
  readonly accepted: number;
  readonly articles: Readonly<Record<string, readonly [number, boolean]>>;
};

export type CheckResult = {
  readonly file: string;
  readonly sameShown: boolean;
  readonly sameTaught: boolean;
  readonly sameDecisions: boolean;
  readonly accepted: { readonly expected: number; readonly actual: number };
  readonly maxDifference: {
    readonly probability: number;
    readonly threshold: number;
  };
};

const FOLDER = join(EVAL_FOLDER, 'implementation-check');

// Runs the design of the record through the package, and compares the result
// with each record file: the frozen record of the research, and the record
// of the research code on the vectors rounded to float32 as a collection
// stores them (README.md, "Implementation check").
export async function implementationCheck(): Promise<CheckResult[]> {
  const profile = readProfiles().find(({ id }) => id === 'security');
  const descriptionVector = descriptionVectors().get('security');
  if (profile === undefined || descriptionVector === undefined)
    throw new Error(
      'The profile security or its description vector is missing.',
    );
  using slice = new LoadedSet('fresh');
  const similarities = slice.similarities(descriptionVector);
  const matches = slice.matches(profile.narrow);
  const labels = slice.labelsFor('security');
  const window = windowOf(slice);
  const pool: Candidate[] = slice.articles.flatMap(({ id }, index) =>
    window[index]
      ? [
          {
            id,
            similarity: similarities[index] ?? Number.NaN,
            match: matches[index] ?? false,
            label: labels[index],
          },
        ]
      : [],
  );
  const answers = teach(pool, 10);
  const stream = scoredStream(slice, window);
  const scores = await runDesign({
    keyword: profile.narrow,
    answers,
    vectors: slice.collection,
    descriptionVector,
    stream,
    textOf: slice.textOf,
  });
  const threshold = new ExpectedFThreshold({ beta: 0.5 });
  const accepted = new Set(scores.accepted(threshold));
  return ['implementation-check.json', 'float32-reference.json'].map((file) => {
    const record: CheckRecord = JSON.parse(
      readFileSync(join(FOLDER, file), 'utf8'),
    );
    const entries = Object.entries(record.articles);
    return {
      file,
      sameShown: equal(answers.shown, record.shownIds),
      sameTaught:
        equal(answers.relevant, record.taughtRelevant) &&
        equal(answers.notRelevant, record.taughtNotRelevant),
      sameDecisions: entries.every(
        ([id, [, accept]]) => accepted.has(id) === accept,
      ),
      accepted: { expected: record.accepted, actual: accepted.size },
      maxDifference: {
        probability: Math.max(
          ...entries.map(([id, [probability]]) =>
            Math.abs(scores.probability(id) - probability),
          ),
        ),
        threshold: Math.abs(threshold.cut(scores) - record.threshold),
      },
    };
  });
}

function equal(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
