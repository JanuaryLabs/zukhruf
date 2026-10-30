import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TaughtAnswers } from './index.ts';

describe('TaughtAnswers', () => {
  test('answers with no yes give no taught answers, so no similarity scorer can be made from them', () => {
    assert.equal(TaughtAnswers.parse(new Map()), undefined);
    assert.equal(
      TaughtAnswers.parse(
        new Map([
          ['a', { relevant: false, text: 'A' }],
          ['b', { relevant: false, text: 'B' }],
        ]),
      ),
      undefined,
    );
  });

  test('keeps each yes and no answer with the text of its article, in the order of the answers', () => {
    const taught = TaughtAnswers.parse(
      new Map([
        ['no-1', { relevant: false, text: 'Chips' }],
        ['yes-1', { relevant: true, text: 'A breach' }],
        ['no-2', { relevant: false, text: 'Markets' }],
        ['yes-2', { relevant: true, text: 'A patch' }],
      ]),
    );

    assert.deepEqual(
      [taught?.relevant, taught?.notRelevant],
      [
        [
          { id: 'yes-1', text: 'A breach' },
          { id: 'yes-2', text: 'A patch' },
        ],
        [
          { id: 'no-1', text: 'Chips' },
          { id: 'no-2', text: 'Markets' },
        ],
      ],
    );
  });
});
