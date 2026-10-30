import assert from 'node:assert/strict';
import { test } from 'node:test';

import { metrics } from './metrics.ts';

// The test cases of the reference scorer, github.com/conll/reference-coreference-scorers
// at commit f49f3f8 (v8.01): test/CorefMetricTestConfig.pm gives the expected
// [recall, precision, F1] of each case, as published there, and
// test/DataFiles gives the key and the response in the CoNLL format. Each
// mention here is its token span, start-end, counted from the first token
// of the document, as CorScorer.pm counts them. A response mention that is
// repeated is kept once, as CorScorer.pm keeps it (IdentifMentions); thus
// case A9 is here with its published values, although v8.01 refuses to score
// it for its more than 10 repeated mentions. The reference scorer passes
// every other case (perl test/test.pl). The config has no expected value
// for some metrics of some cases; those are not here either. CEAF-m is not
// part of this harness.
//
// The tolerance is that of test/test.pl: the sum of the three absolute
// differences is less than 1e-4.
const CASES: readonly {
  readonly id: string;
  readonly files: readonly [string, string];
  readonly key: readonly (readonly string[])[];
  readonly response: readonly (readonly string[])[];
  readonly expected: Partial<
    Record<
      'muc' | 'bCubed' | 'ceafE' | 'blanc',
      readonly [number, number, number]
    >
  >;
}[] = [
  {
    id: 'A1',
    files: ['TC-A.key', 'TC-A-1.response'],
    key: [['0-1'], ['3-6', '9-9'], ['11-12', '14-14', '16-18']],
    response: [['0-1'], ['3-6', '9-9'], ['11-12', '14-14', '16-18']],
    expected: {
      muc: [1, 1, 1],
      bCubed: [6 / 6, 6 / 6, 1],
      ceafE: [1, 1, 1],
      blanc: [1, 1, 1],
    },
  },
  {
    id: 'A2',
    files: ['TC-A.key', 'TC-A-2.response'],
    key: [['0-1'], ['3-6', '9-9'], ['11-12', '14-14', '16-18']],
    response: [['0-1'], ['11-12', '14-14']],
    expected: {
      muc: [1 / 3, 1 / 1, 0.5],
      bCubed: [7 / 3 / 6, 3 / 3, 14 / 25],
      ceafE: [0.6, 0.9, 0.72],
      blanc: [0.21591, 1, 0.35385],
    },
  },
  {
    id: 'A3',
    files: ['TC-A.key', 'TC-A-3.response'],
    key: [['0-1'], ['3-6', '9-9'], ['11-12', '14-14', '16-18']],
    response: [
      ['0-1'],
      ['3-6', '9-9', '10-10'],
      ['11-12', '13-13', '14-14', '16-18'],
      ['15-15'],
    ],
    expected: {
      muc: [3 / 3, 3 / 5, 0.75],
      bCubed: [6 / 6, (4 + 7 / 12) / 9, 110 / 163],
      ceafE: [0.88571, 0.66429, 0.75918],
      blanc: [1, 0.42593, 0.59717],
    },
  },
  {
    id: 'A4',
    files: ['TC-A.key', 'TC-A-4.response'],
    key: [['0-1'], ['3-6', '9-9'], ['11-12', '14-14', '16-18']],
    response: [['0-1'], ['3-6', '9-9', '10-10'], ['11-12', '15-15'], ['13-13']],
    expected: {
      muc: [1 / 3, 1 / 3, 1 / 3],
      bCubed: [
        (3 + 1 / 3) / 6,
        (1 + 4 / 3 + 1 / 2) / 7,
        (2 * (5 / 9) * (17 / 42)) / (5 / 9 + 17 / 42),
      ],
      ceafE: [0.73333, 0.55, 0.62857],
      blanc: [0.35227, 0.27206, 0.30357],
    },
  },
  {
    id: 'A5',
    files: ['TC-A.key', 'TC-A-5.response'],
    key: [['0-1'], ['3-6', '9-9'], ['11-12', '14-14', '16-18']],
    response: [
      ['0-1'],
      ['4-5', '3-6', '9-9', '10-10'],
      ['11-12', '15-15'],
      ['13-13'],
    ],
    expected: {
      muc: [1 / 3, 1 / 4, 2 / 7],
      bCubed: [
        (3 + 1 / 3) / 6,
        2.5 / 8,
        (2 * (5 / 9) * (5 / 16)) / (5 / 9 + 5 / 16),
      ],
      ceafE: [0.68889, 0.51667, 0.59048],
      blanc: [0.35227, 0.19048, 0.24716],
    },
  },
  {
    id: 'A6',
    files: ['TC-A.key', 'TC-A-6.response'],
    key: [['0-1'], ['3-6', '9-9'], ['11-12', '14-14', '16-18']],
    response: [
      ['0-1'],
      ['3-6', '9-9', '10-10'],
      ['4-5', '13-13'],
      ['11-12', '15-15'],
    ],
    expected: {
      muc: [1 / 3, 1 / 4, 2 / 7],
      bCubed: [
        10 / 3 / 6,
        (1 + 4 / 3 + 1 / 2) / 8,
        (2 * (5 / 9) * (17 / 48)) / (5 / 9 + 17 / 48),
      ],
      ceafE: [0.73333, 0.55, 0.62857],
      blanc: [0.35227, 0.2087, 0.25817],
    },
  },
  {
    id: 'A7',
    files: ['TC-A.key', 'TC-A-7.response'],
    key: [['0-1'], ['3-6', '9-9'], ['11-12', '14-14', '16-18']],
    response: [['0-1'], ['3-6', '9-9', '10-10'], ['11-12', '15-15'], ['13-13']],
    expected: {
      muc: [1 / 3, 1 / 3, 1 / 3],
      bCubed: [
        10 / 3 / 6,
        (1 + 4 / 3 + 1 / 2) / 7,
        (2 * (5 / 9) * (17 / 42)) / (5 / 9 + 17 / 42),
      ],
      ceafE: [0.73333, 0.55, 0.62857],
      blanc: [0.35227, 0.27206, 0.30357],
    },
  },
  {
    id: 'A8',
    files: ['TC-A.key', 'TC-A-8.response'],
    key: [['0-1'], ['3-6', '9-9'], ['11-12', '14-14', '16-18']],
    response: [['0-1'], ['3-6', '9-9', '10-10'], ['13-13'], ['11-12', '15-15']],
    expected: {
      muc: [1 / 3, 1 / 3, 1 / 3],
      bCubed: [
        10 / 3 / 6,
        (1 + 4 / 3 + 1 / 2) / 7,
        (2 * (5 / 9) * (17 / 42)) / (5 / 9 + 17 / 42),
      ],
      ceafE: [0.73333, 0.55, 0.62857],
      blanc: [0.35227, 0.27206, 0.30357],
    },
  },
  {
    id: 'A9',
    files: ['TC-A.key', 'TC-A-9.response'],
    key: [['0-1'], ['3-6', '9-9'], ['11-12', '14-14', '16-18']],
    response: [['0-1'], ['3-6', '9-9', '10-10'], ['13-13'], ['11-12', '15-15']],
    expected: {
      muc: [1 / 3, 1 / 3, 1 / 3],
      bCubed: [
        10 / 3 / 6,
        (1 + 4 / 3 + 1 / 2) / 7,
        (2 * (5 / 9) * (17 / 42)) / (5 / 9 + 17 / 42),
      ],
      ceafE: [0.73333, 0.55, 0.62857],
      blanc: [0.35227, 0.27206, 0.30357],
    },
  },
  {
    id: 'A10',
    files: ['TC-A.key', 'TC-A-10.response'],
    key: [['0-1'], ['3-6', '9-9'], ['11-12', '14-14', '16-18']],
    response: [['0-1'], ['3-6'], ['9-9'], ['11-12'], ['14-14'], ['16-18']],
    expected: {
      muc: [0, 0, 0],
      bCubed: [3 / 6, 6 / 6, 2 / 3],
      blanc: [0.5, 0.36667, 0.42308],
    },
  },
  {
    id: 'A11',
    files: ['TC-A.key', 'TC-A-11.response'],
    key: [['0-1'], ['3-6', '9-9'], ['11-12', '14-14', '16-18']],
    response: [['0-1', '3-6', '9-9', '11-12', '14-14', '16-18']],
    expected: {
      muc: [3 / 3, 3 / 5, 6 / 8],
      bCubed: [6 / 6, (1 / 6 + (2 * 2) / 6 + (3 * 3) / 6) / 6, 14 / 25],
      blanc: [0.5, 0.13333, 0.21053],
    },
  },
  {
    id: 'A12',
    files: ['TC-A.key', 'TC-A-12.response'],
    key: [['0-1'], ['3-6', '9-9'], ['11-12', '14-14', '16-18']],
    response: [
      ['0-1'],
      ['3-4'],
      ['7-7'],
      ['9-9'],
      ['11-12'],
      ['14-14'],
      ['16-16'],
    ],
    expected: {
      muc: [0, 0, 0],
      bCubed: [
        (1 + 1 / 2 + 2 / 3) / 6,
        4 / 7,
        (2 * (13 / 36) * (4 / 7)) / (13 / 36 + 4 / 7),
      ],
      blanc: [0.22727, 0.11905, 0.15625],
    },
  },
  {
    id: 'A13',
    files: ['TC-A.key', 'TC-A-13.response'],
    key: [['0-1'], ['3-6', '9-9'], ['11-12', '14-14', '16-18']],
    response: [['0-1', '3-4', '7-7', '9-9', '11-12', '14-14', '16-16']],
    expected: {
      muc: [1 / 3, 1 / 6, 2 / 9],
      bCubed: [
        (1 + 1 / 2 + (2 * 2) / 3) / 6,
        (1 / 7 + 1 / 7 + (2 * 2) / 7) / 7,
        (2 * (17 / 36) * (6 / 49)) / (17 / 36 + 6 / 49),
      ],
      blanc: [0.125, 0.02381, 0.04],
    },
  },
  {
    id: 'B1',
    files: ['TC-B.key', 'TC-B-1.response'],
    key: [
      ['1-12', '47-47'],
      ['29-31', '62-63', '66-66'],
    ],
    response: [
      ['29-31', '47-47', '54-58'],
      ['62-63', '66-66'],
    ],
    expected: {
      blanc: [
        (1 / 2) * (1 / 4 + 1 / 3),
        (1 / 2) * (1 / 4 + 1 / 3),
        (1 / 2) * (1 / 4 + 1 / 3),
      ],
    },
  },
  {
    id: 'C1',
    files: ['TC-C.key', 'TC-C-1.response'],
    key: [
      ['1-12', '47-47'],
      ['29-31', '62-63', '66-66'],
      ['69-69', '70-70'],
    ],
    response: [
      ['29-31', '47-47', '54-58'],
      ['62-63', '66-66'],
      ['69-69', '70-70'],
    ],
    expected: {
      blanc: [
        (1 / 2) * (2 / 5 + 10 / 16),
        (1 / 2) * (2 / 5 + 10 / 16),
        (1 / 2) * (2 / 5 + 10 / 16),
      ],
    },
  },
  {
    id: 'D1',
    files: ['TC-D.key', 'TC-D-1.response'],
    key: [
      ['1-1', '3-3', '5-5', '7-7', '9-9'],
      ['13-13', '15-15'],
      ['19-19', '21-21', '23-23', '25-25', '27-27'],
    ],
    response: [
      ['1-1', '3-3', '5-5', '7-7', '9-9'],
      ['13-13', '15-15', '19-19', '21-21', '23-23', '25-25', '27-27'],
    ],
    expected: {
      muc: [9 / 9, 9 / 10, (2 * (9 / 9) * (9 / 10)) / (9 / 9 + 9 / 10)],
      bCubed: [
        12 / 12,
        16 / 21,
        (2 * (12 / 12) * (16 / 21)) / (12 / 12 + 16 / 21),
      ],
    },
  },
  {
    id: 'E1',
    files: ['TC-E.key', 'TC-E-1.response'],
    key: [
      ['1-1', '3-3', '5-5', '7-7', '9-9'],
      ['13-13', '15-15'],
      ['19-19', '21-21', '23-23', '25-25', '27-27'],
    ],
    response: [
      [
        '1-1',
        '3-3',
        '5-5',
        '7-7',
        '9-9',
        '19-19',
        '21-21',
        '23-23',
        '25-25',
        '27-27',
      ],
      ['13-13', '15-15'],
    ],
    expected: {
      muc: [9 / 9, 9 / 10, (2 * (9 / 9) * (9 / 10)) / (9 / 9 + 9 / 10)],
      bCubed: [1, 7 / 12, (2 * 1 * (7 / 12)) / (1 + 7 / 12)],
    },
  },
  {
    id: 'F1',
    files: ['TC-F.key', 'TC-F-1.response'],
    key: [['1-1', '3-3', '5-5', '7-7']],
    response: [
      ['1-1', '3-3'],
      ['5-5', '7-7'],
    ],
    expected: {
      muc: [2 / 3, 2 / 2, (2 * (2 / 3) * (2 / 2)) / (2 / 3 + 2 / 2)],
    },
  },
  {
    id: 'G1',
    files: ['TC-G.key', 'TC-G-1.response'],
    key: [
      ['1-1', '3-3'],
      ['5-5', '7-7'],
    ],
    response: [['1-1', '3-3', '5-5', '7-7']],
    expected: {
      muc: [2 / 2, 2 / 3, (2 * (2 / 2) * (2 / 3)) / (2 / 2 + 2 / 3)],
    },
  },
  {
    id: 'H1',
    files: ['TC-H.key', 'TC-H-1.response'],
    key: [['1-1', '3-3', '5-5', '7-7']],
    response: [['1-1', '3-3', '5-5', '7-7']],
    expected: {
      muc: [1, 1, 1],
    },
  },
  {
    id: 'I1',
    files: ['TC-I.key', 'TC-I-1.response'],
    key: [['1-1', '3-3', '5-5', '7-7']],
    response: [
      ['1-1', '3-3'],
      ['5-5', '7-7'],
    ],
    expected: {
      muc: [2 / 3, 2 / 2, (2 * (2 / 3) * (2 / 2)) / (2 / 3 + 2 / 2)],
    },
  },
  {
    id: 'J1',
    files: ['TC-J.key', 'TC-J-1.response'],
    key: [['1-1', '3-3', '5-5']],
    response: [['1-1', '5-5']],
    expected: {
      muc: [1 / 2, 1 / 1, (2 * (1 / 2) * (1 / 1)) / (1 / 2 + 1 / 1)],
    },
  },
  {
    id: 'K1',
    files: ['TC-K.key', 'TC-K-1.response'],
    key: [['3-3', '5-5', '7-7', '9-9', '13-13', '15-15', '19-19']],
    response: [
      ['1-1', '3-3', '5-5'],
      ['7-7', '9-9', '11-11'],
      ['13-13', '15-15', '17-17'],
    ],
    expected: {
      muc: [3 / 6, 3 / 6, 3 / 6],
    },
  },
  {
    id: 'L1',
    files: ['TC-L.key', 'TC-L-1.response'],
    key: [
      ['1-1', '3-3', '5-5'],
      ['7-7', '9-9', '11-11', '13-13'],
    ],
    response: [
      ['1-1', '3-3'],
      ['5-5', '7-7'],
      ['11-11', '13-13', '15-15'],
    ],
    expected: {
      muc: [2 / 5, 2 / 4, (2 * (2 / 5) * (2 / 4)) / (2 / 5 + 2 / 4)],
    },
  },
  {
    id: 'M1',
    files: ['TC-M.key', 'TC-M-1.response'],
    key: [['0-1', '3-6', '9-9', '11-12', '14-14', '16-18']],
    response: [['0-1', '3-6', '9-9', '11-12', '14-14', '16-18']],
    expected: {
      muc: [1, 1, 1],
      bCubed: [1, 1, 1],
      ceafE: [1, 1, 1],
      blanc: [1, 1, 1],
    },
  },
  {
    id: 'M2',
    files: ['TC-M.key', 'TC-M-2.response'],
    key: [['0-1', '3-6', '9-9', '11-12', '14-14', '16-18']],
    response: [['0-1'], ['3-6'], ['9-9'], ['11-12'], ['14-14'], ['16-18']],
    expected: {
      muc: [0, 0, 0],
      blanc: [0, 0, 0],
    },
  },
  {
    id: 'M3',
    files: ['TC-M.key', 'TC-M-3.response'],
    key: [['0-1', '3-6', '9-9', '11-12', '14-14', '16-18']],
    response: [['0-1', '3-6'], ['9-9', '11-12', '14-14'], ['16-18']],
    expected: {
      blanc: [0.26667, 1, 0.42105],
    },
  },
  {
    id: 'M4',
    files: ['TC-M.key', 'TC-M-4.response'],
    key: [['0-1', '3-6', '9-9', '11-12', '14-14', '16-18']],
    response: [['0-1', '3-6', '9-9', '10-10', '13-13', '15-15']],
    expected: {
      blanc: [0.2, 0.2, 0.2],
    },
  },
  {
    id: 'M5',
    files: ['TC-M.key', 'TC-M-5.response'],
    key: [['0-1', '3-6', '9-9', '11-12', '14-14', '16-18']],
    response: [['0-1'], ['3-6'], ['9-9'], ['10-10'], ['13-13'], ['15-15']],
    expected: {
      muc: [0, 0, 0],
      blanc: [0, 0, 0],
    },
  },
  {
    id: 'M6',
    files: ['TC-M.key', 'TC-M-6.response'],
    key: [['0-1', '3-6', '9-9', '11-12', '14-14', '16-18']],
    response: [['0-1', '3-6'], ['9-9', '10-10', '13-13'], ['15-15']],
    expected: {
      blanc: [0.06667, 0.25, 0.10526],
    },
  },
  {
    id: 'N1',
    files: ['TC-N.key', 'TC-N-1.response'],
    key: [['0-1'], ['3-6'], ['9-9'], ['11-12'], ['14-14'], ['16-18']],
    response: [['0-1'], ['3-6'], ['9-9'], ['11-12'], ['14-14'], ['16-18']],
    expected: {
      muc: [0, 0, 0],
      blanc: [1, 1, 1],
    },
  },
  {
    id: 'N2',
    files: ['TC-N.key', 'TC-N-2.response'],
    key: [['0-1'], ['3-6'], ['9-9'], ['11-12'], ['14-14'], ['16-18']],
    response: [['0-1', '3-6', '9-9', '11-12', '14-14', '16-18']],
    expected: {
      muc: [0, 0, 0],
      blanc: [0, 0, 0],
    },
  },
  {
    id: 'N3',
    files: ['TC-N.key', 'TC-N-3.response'],
    key: [['0-1'], ['3-6'], ['9-9'], ['11-12'], ['14-14'], ['16-18']],
    response: [['0-1', '3-6'], ['9-9', '11-12', '14-14'], ['16-18']],
    expected: {
      blanc: [0.73333, 1, 0.84615],
    },
  },
  {
    id: 'N4',
    files: ['TC-N.key', 'TC-N-4.response'],
    key: [['0-1'], ['3-6'], ['9-9'], ['11-12'], ['14-14'], ['16-18']],
    response: [['0-1'], ['3-6'], ['9-9'], ['10-10'], ['13-13'], ['15-15']],
    expected: {
      muc: [0, 0, 0],
      blanc: [0.2, 0.2, 0.2],
    },
  },
  {
    id: 'N5',
    files: ['TC-N.key', 'TC-N-5.response'],
    key: [['0-1'], ['3-6'], ['9-9'], ['11-12'], ['14-14'], ['16-18']],
    response: [['0-1', '3-6', '9-9', '10-10', '13-13', '15-15']],
    expected: {
      blanc: [0, 0, 0],
    },
  },
  {
    id: 'N6',
    files: ['TC-N.key', 'TC-N-6.response'],
    key: [['0-1'], ['3-6'], ['9-9'], ['11-12'], ['14-14'], ['16-18']],
    response: [['0-1', '3-6'], ['9-9', '10-10', '13-13'], ['15-15']],
    expected: {
      blanc: [0.13333, 0.18182, 0.15385],
    },
  },
];

function partition(
  clusters: readonly (readonly string[])[],
): Map<string, string> {
  return new Map(
    clusters.flatMap((mentions, entity) =>
      mentions.map((mention) => [mention, String(entity)] as const),
    ),
  );
}

for (const { id, files, key, response, expected } of CASES)
  test(`reference scorer case ${id} (${files.join(' against ')}) gives the published recall, precision and F1`, () => {
    const scores = metrics(partition(key), partition(response));

    for (const metric of ['muc', 'bCubed', 'ceafE', 'blanc'] as const) {
      const published = expected[metric];
      if (published === undefined) continue;
      const [recall, precision, f1] = published;
      const actual = scores[metric];
      const difference =
        Math.abs(actual.recall - recall) +
        Math.abs(actual.precision - precision) +
        Math.abs(actual.f1 - f1);
      assert.ok(
        difference < 1e-4,
        `${metric}: expected R ${recall} P ${precision} F1 ${f1}, got R ${actual.recall} P ${actual.precision} F1 ${actual.f1}`,
      );
    }
  });
