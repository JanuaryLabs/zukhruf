import assert from 'node:assert/strict';

import type * as Mdast from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { toString } from 'mdast-util-to-string';
import { gfmTable } from 'micromark-extension-gfm-table';

import { test } from '@zukhruf/parameterized-test';

import {
  Bars,
  Heatmap,
  Line,
  Note,
  type Primitive,
  Scatter,
  Table,
  ValuePairs,
} from '../index.ts';
import { MarkdownRenderer, Page } from './index.ts';

const render = (...primitives: Primitive[]) =>
  new MarkdownRenderer().render(
    new Page('offers', [{ id: 'one', claim: 'A claim', primitives }]),
  );

const parse = (markdown: string) =>
  fromMarkdown(markdown, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });

// What a reader of the Markdown sees: a heading with its level, each table as
// its rows of cell texts, and the text of any other block.
const read = (markdown: string) =>
  parse(markdown).children.map((node) =>
    node.type === 'table'
      ? node.children.map((row) => row.children.map((cell) => toString(cell)))
      : node.type === 'heading'
        ? `${'#'.repeat(node.depth)} ${toString(node)}`
        : toString(node),
  );

// The kinds of node that a reader's parser finds, each once.
const kinds = (node: Mdast.Nodes): readonly string[] => [
  node.type,
  ...('children' in node ? node.children.flatMap(kinds) : []),
];

test('the page has its title as the first heading, the claim of each section as a heading above its primitives, and a table with its columns lined up', () => {
  const markdown = new MarkdownRenderer().render(
    new Page('Offers on 307 pages', [
      {
        id: 'recall',
        claim: 'DeepSeek meets the recall bar',
        primitives: [
          new Table(
            ['score', 'Haiku'],
            [
              [
                { text: 'values_recall', tone: 'neutral' },
                { text: '0.868', tone: 'bad' },
              ],
            ],
          ),
        ],
      },
      {
        id: 'replays',
        claim: 'Most answers were replayed',
        primitives: [new Note('711 of 921 answers.')],
      },
    ]),
  );

  assert.equal(
    markdown,
    `# Offers on 307 pages

## DeepSeek meets the recall bar

| score         | Haiku   |
| ------------- | ------- |
| values_recall | ✗ 0.868 |

## Most answers were replayed

711 of 921 answers.
`,
  );
});

void test.each(
  [
    {
      name: 'a table, with an icon for a good or bad cell',
      primitive: new Table(
        ['score', 'Haiku', 'DeepSeek'],
        [
          [
            { text: 'values_recall', tone: 'neutral' },
            { text: '0.868', tone: 'bad' },
            { text: '0.902', tone: 'good' },
          ],
        ],
      ),
      blocks: [
        [
          ['score', 'Haiku', 'DeepSeek'],
          ['values_recall', '✗ 0.868', '✓ 0.902'],
        ],
      ],
    },
    {
      name: 'the bars, and the marks of the bars as a table of their own',
      primitive: new Bars({
        bars: [
          {
            label: 'values_recall',
            value: 0.868,
            ends: { low: 0.8, high: 0.93 },
            tone: 'bad',
          },
          { label: 'empty pages', value: 0.95, ends: undefined, tone: 'good' },
        ],
        scale: { low: 0, high: 1 },
        marks: [{ label: 'bar', at: 0.88 }],
      }),
      blocks: [
        [
          ['Bar', 'Value', 'Low', 'High'],
          ['values_recall', '0.868', '0.800', '0.930'],
          ['empty pages', '0.950', '', ''],
        ],
        [
          ['Mark', 'At'],
          ['bar', '0.880'],
        ],
      ],
    },
    {
      name: 'the points of a scatter',
      primitive: new Scatter({
        x: 'Haiku',
        y: 'DeepSeek',
        points: [{ label: 'clerky.com', x: 0.5, y: 1 }],
      }),
      blocks: [
        [
          ['Test', 'Haiku', 'DeepSeek'],
          ['clerky.com', '0.500', '1.000'],
        ],
      ],
    },
    {
      name: 'the steps of a line, a column for each series',
      primitive: new Line({
        steps: ['run 1', 'run 2'],
        series: [
          {
            label: 'DeepSeek',
            values: [
              { value: 0.85, ends: { low: 0.8, high: 0.9 } },
              { value: 0.9, ends: undefined },
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
      blocks: [
        [
          ['Step', 'DeepSeek', 'Haiku'],
          ['run 1', '0.850 [0.800, 0.900]', '0.820'],
          ['run 2', '0.900', '0.868'],
        ],
      ],
    },
    {
      name: 'the cells of a heatmap',
      primitive: new Heatmap({
        rows: ['clerky.com', 'stripe.com'],
        columns: ['run 1', 'run 2'],
        values: [
          [1, 0.5],
          [0, 0.25],
        ],
      }),
      blocks: [
        [
          ['', 'run 1', 'run 2'],
          ['clerky.com', '1.000', '0.500'],
          ['stripe.com', '0.000', '0.250'],
        ],
      ],
    },
    {
      name: 'value pairs under their title, each with its mark as an icon and a word',
      primitive: new ValuePairs('clerky.com', [
        {
          path: '$.offers[0].kind',
          mark: 'agree',
          expected: 'credits',
          actual: 'credits',
        },
        {
          path: '$.offers[0].amount',
          mark: 'near',
          expected: '$5,000',
          actual: '5000 USD',
        },
        {
          path: '$.offers[0].vendor',
          mark: 'disagree',
          expected: 'AWS',
          actual: 'GCP',
        },
        { path: '$.offers[1]', mark: 'only-expected', expected: 'Stripe' },
        { path: '$.offers[2]', mark: 'only-actual', actual: 'Notion' },
      ]),
      blocks: [
        'clerky.com',
        [
          ['Path', 'Expected', 'Actual', 'Mark'],
          ['$.offers[0].kind', 'credits', 'credits', '✓ agrees'],
          ['$.offers[0].amount', '$5,000', '5000 USD', '≈ near'],
          ['$.offers[0].vendor', 'AWS', 'GCP', '✗ disagrees'],
          ['$.offers[1]', 'Stripe', '', '− only expected'],
          ['$.offers[2]', '', 'Notion', '+ only actual'],
        ],
      ],
    },
  ] satisfies readonly {
    name: string;
    primitive: Primitive;
    blocks: readonly (string | readonly (readonly string[])[])[];
  }[],
  ({ name, primitive, blocks }) =>
    test(`a reader of the markdown sees ${name}`, () => {
      assert.deepEqual(read(render(primitive)), [
        '# offers',
        '## A claim',
        ...blocks,
      ]);
    }),
);

// A string of a page or an answer that a renderer drew as Markdown would
// become an image, a link, emphasis or HTML, or would split a table row.
void test.each(
  [
    '<img src=x onerror=alert(1)>',
    '![pixel](https://tracker.example/p.png)',
    '[link](https://example.com)',
    'a|b and c\\|d',
    '5* _and_ **bold** `code`',
    '# not a heading',
    'line one\nline two',
  ],
  (value) =>
    test(`${JSON.stringify(value)} reads as itself in a heading, a cell, a path, a title and a note`, () => {
      const markdown = new MarkdownRenderer().render(
        new Page(value, [
          {
            id: 'one',
            claim: value,
            primitives: [
              new Table([value], [[{ text: value, tone: 'neutral' }]]),
              new ValuePairs(value, [
                {
                  path: value,
                  mark: 'disagree',
                  expected: value,
                  actual: value,
                },
              ]),
              new Note(value),
            ],
          },
        ]),
      );

      assert.deepEqual(read(markdown), [
        `# ${value}`,
        `## ${value}`,
        [[value], [value]],
        value,
        [
          ['Path', 'Expected', 'Actual', 'Mark'],
          [value, value, value, '✗ disagrees'],
        ],
        value,
      ]);
      assert.deepEqual(
        new Set(kinds(parse(markdown))),
        new Set([
          'root',
          'heading',
          'text',
          'table',
          'tableRow',
          'tableCell',
          'paragraph',
          'strong',
        ]),
      );
    }),
);
