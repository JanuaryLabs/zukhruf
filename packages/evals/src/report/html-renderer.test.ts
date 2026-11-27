import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import {
  Bars,
  Heatmap,
  Line,
  Note,
  type Pair,
  type Primitive,
  Scatter,
  Table,
  ValuePairs,
} from '../index.ts';
import { HtmlRenderer, Page } from './index.ts';

const render = (...primitives: Primitive[]) =>
  new HtmlRenderer().render(
    new Page('offers', [{ id: 'one', claim: 'A claim', primitives }]),
  );

// The tooltips of a page as a reader sees them on hover: a title and rows of
// a value and its label.
const tips = (html: string) =>
  [...html.matchAll(/data-tip="([^"]*)"/g)].map((match) => {
    const json = (match[1] ?? '').replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code)),
    );
    const tip: unknown = JSON.parse(json);
    assert.ok(
      typeof tip === 'object' &&
        tip !== null &&
        'title' in tip &&
        'rows' in tip &&
        Array.isArray(tip.rows),
    );
    return {
      title: tip.title,
      rows: tip.rows.map((row: unknown) =>
        Array.isArray(row) ? row.slice(0, 2) : row,
      ),
    };
  });

test('the page is one text with no html, head or body, its title as the heading, and the claim of each section as the heading of the section', () => {
  const html = new HtmlRenderer().render(
    new Page('Offers on 307 pages', [
      {
        id: 'recall',
        claim: 'DeepSeek meets the recall bar',
        primitives: [new Note('a')],
      },
      {
        id: 'precision',
        claim: 'Haiku misses the precision bar',
        primitives: [new Note('b')],
      },
    ]),
  );

  assert.doesNotMatch(html, /<html|<head|<body/);
  assert.match(html, /<title>Offers on 307 pages<\/title>/);
  assert.match(html, /<h1>Offers on 307 pages<\/h1>/);
  assert.match(
    html,
    /<section class="section" id="recall">\s*<h2>DeepSeek meets the recall bar<\/h2>/,
  );
  assert.match(
    html,
    /<section class="section" id="precision">\s*<h2>Haiku misses the precision bar<\/h2>/,
  );
});

test('the page has dark theme tokens for the system setting and for data-theme', () => {
  const html = render(new Note('a'));

  assert.match(
    html,
    /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{[^}]*--page: #101318/,
  );
  assert.match(html, /:root\[data-theme="dark"\] \{[^}]*--page: #101318/);
});

test('a table shows its header and each cell, and a good or bad cell has an icon and a word beside its colour', () => {
  const html = render(
    new Table(
      ['score', 'Haiku', 'DeepSeek'],
      [
        [
          { text: 'values_recall', tone: 'neutral' },
          { text: '0.868', tone: 'bad' },
          { text: '0.902', tone: 'good' },
        ],
      ],
    ),
  );

  assert.match(
    html,
    /<th scope="col">score<\/th><th scope="col">Haiku<\/th><th scope="col">DeepSeek<\/th>/,
  );
  assert.match(html, /<th scope="row" data-tone="neutral">values_recall<\/th>/);
  assert.match(
    html,
    /<td data-tone="bad"><span class="icon" aria-hidden="true">✗<\/span>0\.868<span class="sr"> \(bad\)<\/span><\/td>/,
  );
  assert.match(
    html,
    /<td data-tone="good"><span class="icon" aria-hidden="true">✓<\/span>0\.902<span class="sr"> \(good\)<\/span><\/td>/,
  );
});

test('a bar shows its value with its interval ends, draws them as a whisker, and labels the rule of each mark', () => {
  const html = render(
    new Bars({
      bars: [
        {
          label: 'values_recall',
          value: 0.868,
          ends: { low: 0.8, high: 0.93 },
          tone: 'bad',
        },
      ],
      scale: { low: 0, high: 1 },
      marks: [{ label: 'bar', at: 0.88 }],
    }),
  );

  assert.match(html, /<span class="bar-name">values_recall<\/span>/);
  assert.match(html, /0\.868 <small>\[0\.800, 0\.930\]<\/small>/);
  assert.match(html, /<span class="bar" style="--x:86\.80%">/);
  assert.match(html, /<span class="whisker" style="--a:80\.00%;--b:93\.00%">/);
  assert.match(html, /<span class="bar-ref" style="--x:88\.00%">/);
  assert.match(html, /<span style="--x:88\.00%">bar 0\.88<\/span>/);
  assert.deepEqual(tips(html), [
    {
      title: 'values_recall',
      rows: [
        ['0.868 [0.800, 0.930]', 'values_recall'],
        ['0.88', 'bar'],
      ],
    },
  ]);
});

test('the label of each mark of bars has a row of its own, so that the labels of two near marks do not overlap', () => {
  const html = render(
    new Bars({
      bars: [{ label: 'recall', value: 0.9, ends: undefined, tone: 'neutral' }],
      scale: { low: 0, high: 1 },
      marks: [
        { label: 'bar', at: 0.88 },
        { label: 'bar', at: 0.95 },
      ],
    }),
  );

  assert.deepEqual(
    [
      ...html.matchAll(/<span class="ref-labels">(.*?)<\/span><span><\/span>/g),
    ].map((match) => (match[1] ?? '').match(/>([^<]*)</g)),
    [['>bar 0.88<'], ['>bar 0.95<']],
  );
});

test('a scatter draws the diagonal y = x and gives each point a tooltip with its test and both values', () => {
  const html = render(
    new Scatter({
      x: 'Haiku',
      y: 'DeepSeek',
      points: [
        { label: 'clerky.com', x: 0.5, y: 1 },
        { label: 'stripe.com', x: 0.75, y: 0.25 },
      ],
    }),
  );

  assert.match(html, /<line class="diagonal" x1="0" y1="100" x2="100" y2="0"/);
  assert.match(html, />y = x</);
  assert.match(html, /DeepSeek ↑/);
  assert.match(html, /Haiku →/);
  assert.deepEqual(tips(html), [
    {
      title: 'clerky.com',
      rows: [
        ['0.500', 'Haiku'],
        ['1.000', 'DeepSeek'],
      ],
    },
    {
      title: 'stripe.com',
      rows: [
        ['0.750', 'Haiku'],
        ['0.250', 'DeepSeek'],
      ],
    },
  ]);
});

test('a line of two series has a legend, an interval band for the series with ends, and a tooltip for each step with every series', () => {
  const html = render(
    new Line({
      steps: ['run 1', 'run 2'],
      series: [
        {
          label: 'DeepSeek',
          values: [
            { value: 0.85, ends: { low: 0.8, high: 0.9 } },
            { value: 0.9, ends: { low: 0.85, high: 0.95 } },
          ],
        },
        {
          label: 'Haiku',
          values: [
            { value: 0.82, ends: undefined },
            { value: 0.868, ends: undefined },
          ],
        },
      ],
    }),
  );

  assert.match(
    html,
    /<ul class="legend"><li data-series="0">DeepSeek<\/li><li data-series="1">Haiku<\/li><\/ul>/,
  );
  assert.equal(html.match(/class="ends-band"/g)?.length, 1);
  assert.equal(html.match(/class="line"/g)?.length, 2);
  assert.deepEqual(tips(html), [
    {
      title: 'run 1',
      rows: [
        ['0.850 [0.800, 0.900]', 'DeepSeek'],
        ['0.820', 'Haiku'],
      ],
    },
    {
      title: 'run 2',
      rows: [
        ['0.900 [0.850, 0.950]', 'DeepSeek'],
        ['0.868', 'Haiku'],
      ],
    },
  ]);
});

test('a line of one series has no legend', () => {
  const html = render(
    new Line({
      steps: ['run 1'],
      series: [{ label: 'recall', values: [{ value: 0.9, ends: undefined }] }],
    }),
  );

  assert.doesNotMatch(html, /class="legend"/);
});

test('a missing value of a line leaves a gap: the line and its band stop before it and start again after it, with no dot there, and its tooltip shows a dash', () => {
  const html = render(
    new Line({
      steps: ['run 1', 'run 2', 'run 3', 'run 4', 'run 5'],
      series: [
        {
          label: 'precision',
          values: [
            { value: 0.9, ends: { low: 0.85, high: 0.95 } },
            { value: 0.8, ends: { low: 0.75, high: 0.85 } },
            { value: Number.NaN, ends: { low: Number.NaN, high: Number.NaN } },
            { value: 0.7, ends: { low: 0.65, high: 0.75 } },
            { value: 0.75, ends: { low: 0.7, high: 0.8 } },
          ],
        },
      ],
    }),
  );

  assert.doesNotMatch(html, /NaN/);
  assert.deepEqual(
    html.match(/class="line" d="([^"]*)"/)?.[1]?.match(/[ML]/g),
    ['M', 'L', 'M', 'L'],
  );
  // One closed area for runs 1 to 2, and one for runs 4 to 5.
  assert.deepEqual(
    html.match(/class="ends-band" d="([^"]*)"/)?.[1]?.match(/[MZ]/g),
    ['M', 'Z', 'M', 'Z'],
  );
  assert.equal(html.match(/class="dot"/g)?.length, 4);
  assert.deepEqual(tips(html)[2], {
    title: 'run 3',
    rows: [['—', 'precision']],
  });
});

test('a heatmap draws a cell for each value, darker for a higher one, with a tooltip of its row, column and value', () => {
  const html = render(
    new Heatmap({
      rows: ['clerky.com', 'stripe.com'],
      columns: ['run 1', 'run 2'],
      values: [
        [1, 0.5],
        [0, 0.25],
      ],
    }),
  );

  assert.deepEqual(
    [
      ...html.matchAll(/class="heat-cell" tabindex="0" style="--v:([\d.]+)"/g),
    ].map((match) => match[1]),
    ['1.000', '0.500', '0.000', '0.250'],
  );
  assert.deepEqual(tips(html), [
    { title: 'clerky.com', rows: [['1.000', 'run 1']] },
    { title: 'clerky.com', rows: [['0.500', 'run 2']] },
    { title: 'stripe.com', rows: [['0.000', 'run 1']] },
    { title: 'stripe.com', rows: [['0.250', 'run 2']] },
  ]);
});

test('a missing value of a heatmap is an empty cell marked missing, with no shade, and its tooltip shows a dash', () => {
  const html = render(
    new Heatmap({
      rows: ['clerky.com'],
      columns: ['run 1', 'run 2'],
      values: [[0.5, Number.NaN]],
    }),
  );

  assert.doesNotMatch(html, /NaN/);
  assert.deepEqual(
    [...html.matchAll(/<span class="heat-cell"([^>]*)>/g)].map((match) =>
      (match[1] ?? '').includes('data-missing'),
    ),
    [false, true],
  );
  assert.equal(html.match(/class="heat-cell"[^>]*--v:/g)?.length, 1);
  assert.deepEqual(tips(html)[1], {
    title: 'clerky.com',
    rows: [['—', 'run 2']],
  });
});

void test.each(
  [
    {
      pair: {
        path: '$.a',
        mark: 'agree',
        expected: 'credits',
        actual: 'credits',
      },
      icon: '✓',
      label: 'agrees',
    },
    {
      pair: {
        path: '$.a',
        mark: 'near',
        expected: '$5,000',
        actual: '5000 USD',
      },
      icon: '≈',
      label: 'near',
    },
    {
      pair: { path: '$.a', mark: 'disagree', expected: '5000', actual: '500' },
      icon: '✗',
      label: 'disagrees',
    },
    {
      pair: { path: '$.a', mark: 'only-expected', expected: 'AWS' },
      icon: '−',
      label: 'only expected',
    },
    {
      pair: { path: '$.a', mark: 'only-actual', actual: 'GCP' },
      icon: '+',
      label: 'only actual',
    },
  ] satisfies readonly {
    pair: Pair;
    icon: string;
    label: string;
  }[],
  ({ pair, icon, label }) =>
    test(`a value pair marked ${pair.mark} shows its path, its sides, an icon and the word ${label}`, () => {
      const html = render(new ValuePairs('clerky.com', [pair]));

      assert.match(
        html,
        /<figcaption class="pairs-title">clerky\.com<\/figcaption>/,
      );
      const row = html.match(/<tr data-mark="[^"]+">.*?<\/tr>/)?.[0];
      assert.equal(
        row,
        `<tr data-mark="${pair.mark}"><th scope="row"><code>$.a</code></th><td>${'expected' in pair ? pair.expected : ''}</td><td>${'actual' in pair ? pair.actual : ''}</td><td class="mark"><span class="icon" aria-hidden="true">${icon}</span>${label}</td></tr>`,
      );
    }),
);

test('a note is a paragraph', () => {
  assert.match(
    render(new Note('711 answers were replayed')),
    /<p class="note">711 answers were replayed<\/p>/,
  );
});

const attack = '<img src=x onerror=alert(1)>';

void test.each(
  [
    {
      name: 'a table cell',
      primitive: new Table([attack], [[{ text: attack, tone: 'good' }]]),
    },
    {
      name: 'a bar label and a mark label',
      primitive: new Bars({
        bars: [{ label: attack, value: 0.5, ends: undefined, tone: 'neutral' }],
        scale: { low: 0, high: 1 },
        marks: [{ label: attack, at: 0.5 }],
      }),
    },
    {
      name: 'the axes and a point of a scatter',
      primitive: new Scatter({
        x: attack,
        y: attack,
        points: [{ label: attack, x: 0, y: 1 }],
      }),
    },
    {
      name: 'the steps and series of a line',
      primitive: new Line({
        steps: [attack],
        series: [
          { label: attack, values: [{ value: 1, ends: undefined }] },
          { label: 'b', values: [{ value: 0, ends: undefined }] },
        ],
      }),
    },
    {
      name: 'the rows and columns of a heatmap',
      primitive: new Heatmap({
        rows: [attack],
        columns: [attack],
        values: [[0.5]],
      }),
    },
    {
      name: 'the title, path and values of a value pair',
      primitive: new ValuePairs(attack, [
        {
          path: attack,
          mark: 'disagree',
          expected: attack,
          actual: `${attack}"'&`,
        },
      ]),
    },
    { name: 'a note', primitive: new Note(attack) },
  ] satisfies readonly { name: string; primitive: Primitive }[],
  ({ name, primitive }) =>
    test(`the html escapes ${name}`, () => {
      const html = new HtmlRenderer().render(
        new Page(attack, [
          { id: attack, claim: attack, primitives: [primitive] },
        ]),
      );

      assert.doesNotMatch(html, /<img/);
      assert.match(html, /&#60;img src=x onerror=alert\(1\)&#62;/);
    }),
);
