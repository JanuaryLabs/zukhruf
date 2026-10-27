import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { readEvents, writeEvents } from './accepted.ts';
import type { EvalSet } from './answer-key.ts';

const ACCEPTED_FOLDER = join(import.meta.dirname, 'accepted');

function evalSet(labelsSha256: string): EvalSet {
  return {
    name: 'tiny',
    folder: '',
    metadata: {
      role: 'training',
      frozenAt: '2026-10-27T00:00:00Z',
      firstScoredAt: null,
      labelsSha256,
      annotator: '',
      boundaryRule: '',
      text: 'web',
      source: { name: '', url: '', licence: '', attribution: '' },
      weaknesses: [],
    },
    rows: ['a', 'b', 'c', 'd'].map((id) => ({
      id,
      source: `https://example.com/${id}`,
      publishedAt: null,
      event: id,
      textSha256: '',
    })),
  };
}

test('the events of an accepted design come back for each answer-key row, without the reports it did not score', () => {
  const design = `test-${process.pid}-${Date.now()}`;
  try {
    // c vanished in the run of the design.
    writeEvents(design, [
      {
        set: evalSet('labels-1'),
        eventOf: new Map([
          ['a', 'e7'],
          ['b', 'e7'],
          ['d', 'e9'],
        ]),
      },
    ]);

    const events = readEvents(design, evalSet('labels-1'));

    assert.deepEqual([...(events?.keys() ?? [])], ['a', 'b', 'd']);
    assert.equal(events?.get('a'), events?.get('b'));
    assert.notEqual(events?.get('a'), events?.get('d'));
  } finally {
    rmSync(join(ACCEPTED_FOLDER, `${design}.json`), { force: true });
  }
});

test('the events of an accepted design on other labels are none, so no change is computed on misaligned rows', () => {
  const design = `test-${process.pid}-${Date.now()}`;
  try {
    writeEvents(design, [
      { set: evalSet('labels-1'), eventOf: new Map([['a', 'e1']]) },
    ]);

    assert.equal(readEvents(design, evalSet('labels-fixed')), null);
  } finally {
    rmSync(join(ACCEPTED_FOLDER, `${design}.json`), { force: true });
  }
});
