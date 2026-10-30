import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ConflictingAnswerError, Profile } from './index.ts';

describe('Profile', () => {
  test('with gives a corrected copy and leaves the profile as it was', () => {
    const profile = new Profile({
      name: 'security',
      description: 'Attacks and breaches.',
      relevant: ['a'],
      notRelevant: ['b'],
    });

    const corrected = profile.with({
      relevant: ['a', 'c'],
      keywords: ['secur'],
    });

    assert.deepEqual(
      [
        corrected.name,
        corrected.relevant,
        corrected.notRelevant,
        corrected.keywords,
      ],
      ['security', ['a', 'c'], ['b'], ['secur']],
    );
    assert.deepEqual([profile.relevant, profile.keywords], [['a'], []]);
    assert.ok(Object.isFrozen(profile.relevant));
  });

  test('an article that is both a relevant and a not-relevant answer is a ConflictingAnswerError, also in a correction', () => {
    const fields = { name: 'jobs', description: 'Jobs.', notRelevant: ['x'] };

    assert.throws(
      () => new Profile({ ...fields, relevant: ['x'] }),
      (error) => error instanceof ConflictingAnswerError && error.id === 'x',
    );
    assert.throws(
      () => new Profile({ ...fields, relevant: [] }).with({ relevant: ['x'] }),
      ConflictingAnswerError,
    );
  });
});
