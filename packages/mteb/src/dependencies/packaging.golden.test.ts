import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { TaskResult } from '../results/task-result.ts';
import { Version } from './packaging.ts';

// fixtures/packaging/expected.json holds what packaging 26.3 and MTEB 2.26.28
// gave: the normal form of each text or the message of its InvalidVersion,
// the valid texts sorted by Version, and the top-level mteb_version of MTEB
// for subsets of two versions. fixtures/packaging/generate.py makes it.
type Expected = {
  readonly versions: readonly (
    | { readonly text: string; readonly normal: string }
    | { readonly text: string; readonly error: string }
  )[];
  readonly sorted: readonly string[];
  readonly ranges: readonly {
    readonly versions: readonly [string, string];
    readonly mteb_version: string;
  }[];
};

const expected: Expected = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/packaging/expected.json'),
    'utf8',
  ),
);

test('each version has the normal form of packaging, with every digit, and an invalid text gives null', () => {
  const normals = expected.versions.map(({ text }) => [
    text,
    Version.tryParse(text)?.toString() ?? null,
  ]);

  assert.deepEqual(
    normals,
    expected.versions.map((entry) => [
      entry.text,
      'normal' in entry ? entry.normal : null,
    ]),
  );
});

test('parse of an invalid text throws the message of packaging', () => {
  const invalid = expected.versions.flatMap((entry) =>
    'error' in entry ? [entry] : [],
  );

  for (const { text, error } of invalid)
    assert.throws(() => Version.parse(text), { message: error });
});

test('versions sort in the order of packaging, with every digit', () => {
  const valid = expected.versions.flatMap((entry) =>
    'normal' in entry ? [entry.text] : [],
  );

  const sorted = valid.toSorted((left, right) =>
    Version.parse(left).compare(Version.parse(right)),
  );

  assert.deepEqual(sorted, expected.sorted);
});

for (const range of expected.ranges)
  test(`a merge of subsets with the versions ${range.versions.join(' and ')} gives the version range of MTEB`, () => {
    const [low, high] = range.versions;
    const subset = (name: string, version: string) =>
      new TaskResult({
        datasetRevision: '1.0',
        taskName: 'dummy_task',
        mtebVersion: version,
        scores: {
          test: [
            {
              main_score: 0.5,
              hf_subset: name,
              languages: ['eng-Latn'],
              mteb_version: version,
            },
          ],
        },
        evaluationTime: 1,
      });

    const merged = subset('s0', low).merge(subset('s1', high));

    assert.equal(merged.mtebVersion, range.mteb_version);
  });
