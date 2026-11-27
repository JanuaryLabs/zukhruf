import type * as Mdast from 'mdast';
import { gfmTableToMarkdown } from 'mdast-util-gfm-table';
import { toMarkdown } from 'mdast-util-to-markdown';

import type {
  Bars,
  Heatmap,
  Line,
  Note,
  PrimitiveVisitor,
  Scatter,
  Table,
  ValuePairs,
} from '../index.ts';
import { marks, tones } from './data-tables.ts';
import type { Page } from './page.ts';

const text = (value: string): Mdast.Text => ({ type: 'text', value });

const table = ({
  columns,
  rows,
}: {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}): Mdast.Table => ({
  type: 'table',
  children: [columns, ...rows].map((cells) => ({
    type: 'tableRow',
    children: cells.map((cell) => ({
      type: 'tableCell',
      children: [text(cell)],
    })),
  })),
});

// Every string of a primitive comes from a page or an answer, so remark's
// writer escapes each character that would start Markdown or HTML there, and
// a reader of the page reads the string itself (report ADR 0003).
const write = (...nodes: Mdast.RootContent[]) =>
  toMarkdown(
    { type: 'root', children: nodes },
    { extensions: [gfmTableToMarkdown()] },
  ).trimEnd();

// Draws each primitive as Markdown: a GFM table for a table, a chart as the
// table that it carries, so that each number prints once (ADR 0011), and a
// paragraph for a note. A page is a heading for its title and one for
// the claim of each section.
export class MarkdownRenderer implements PrimitiveVisitor<string> {
  render(page: Page): string {
    return `${[
      write({ type: 'heading', depth: 1, children: [text(page.title)] }),
      ...page.sections.flatMap((section) => [
        write({ type: 'heading', depth: 2, children: [text(section.claim)] }),
        ...section.primitives.map((primitive) => primitive.accept(this)),
      ]),
    ].join('\n\n')}\n`;
  }

  table(source: Table): string {
    return write(
      table({
        columns: source.columns,
        rows: source.rows.map((cells) =>
          cells.map((cell) =>
            cell.tone === 'neutral'
              ? cell.text
              : `${tones[cell.tone]} ${cell.text}`,
          ),
        ),
      }),
    );
  }

  bars(bars: Bars): string {
    return this.table(bars.table);
  }

  scatter(scatter: Scatter): string {
    return this.table(scatter.table);
  }

  line(line: Line): string {
    return this.table(line.table);
  }

  heatmap(heatmap: Heatmap): string {
    return this.table(heatmap.table);
  }

  valuePairs(pairs: ValuePairs): string {
    return write(
      {
        type: 'paragraph',
        children: [{ type: 'strong', children: [text(pairs.title)] }],
      },
      table({
        columns: ['Path', 'Expected', 'Actual', 'Mark'],
        rows: pairs.pairs.map((pair) => {
          const { icon, label } = marks[pair.mark];
          return [
            pair.path,
            pair.mark === 'only-actual' ? '' : pair.expected,
            pair.mark === 'only-expected' ? '' : pair.actual,
            `${icon} ${label}`,
          ];
        }),
      }),
    );
  }

  note(note: Note): string {
    return write({ type: 'paragraph', children: [text(note.text)] });
  }
}
