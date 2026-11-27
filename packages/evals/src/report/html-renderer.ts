import type {
  Bars,
  Cell,
  Ends,
  Heatmap,
  Line,
  Note,
  PrimitiveVisitor,
  Scatter,
  Table,
  ValuePairs,
} from '../index.ts';
import {
  type DataTable,
  barsTable,
  fixed,
  heatmapTable,
  lineTable,
  marks,
  marksTable,
  scatterTable,
  tones,
  withEnds,
} from './data-tables.ts';
import type { Page } from './page.ts';
import { script } from './script.ts';
import { styles } from './styles.ts';

// A tooltip row: the value, its label, and the series slot of its key.
type TipRow = readonly [value: string, label: string, series?: string];

// Every string of a primitive comes from a page or an answer, so each one is
// escaped (mteb's `esc`).
const esc = (text: string) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const tip = (title: string, rows: readonly TipRow[]) =>
  ` data-tip="${esc(JSON.stringify({ title, rows }))}"`;
// A number on an axis or a mark, with no trailing zeros: 0.88, not 0.880.
const short = (value: number) => String(Number(value.toFixed(3)));
const percent = (share: number) =>
  `${(Math.min(1, Math.max(0, Number.isNaN(share) ? 0 : share)) * 100).toFixed(2)}%`;
// The categorical slots of the palette are eight, in a fixed order; a series
// past them is drawn in the colour of the rest and named by the legend.
const slot = (index: number) => (index < 8 ? String(index) : 'other');

// Ends that hold every value and split into four even steps of a round size
// (1, 2, 2.5 or 5 times a power of ten), so that each tick is a round number.
// Of two such ends, the one that stays inside 0 to 1 wins when the values
// do, since a score has no value past them.
function domain(values: readonly number[]): Ends {
  const known = values.filter((value) => !Number.isNaN(value));
  if (known.length === 0) return { low: 0, high: 1 };
  const min = Math.min(...known);
  const max = Math.max(...known);
  const low = min === max ? min - 0.5 : min;
  const high = min === max ? max + 0.5 : max;
  const power = 10 ** Math.floor(Math.log10((high - low) / 4));
  const unit = min >= 0 && max <= 1;
  for (const size of [1, 2, 2.5, 5, 10, 20]) {
    const step = size * power;
    const fromLow = Math.floor(low / step) * step;
    const fromHigh = Math.ceil(high / step) * step;
    const ends = [
      { low: fromLow, high: fromLow + 4 * step },
      { low: fromHigh - 4 * step, high: fromHigh },
    ].filter((end) => end.low <= low && end.high >= high);
    const inside = ends.find((end) => end.low >= 0 && end.high <= 1);
    const chosen = unit && inside !== undefined ? inside : ends[0];
    if (chosen !== undefined) return chosen;
  }
  return { low, high };
}
const ticks = ({ low, high }: Ends) =>
  [0, 1, 2, 3, 4].map((step) => low + ((high - low) * step) / 4);
const share = ({ low, high }: Ends, value: number) =>
  (value - low) / (high - low);

const tableHtml = ({
  columns,
  rows,
}: DataTable): string => `<div class="table-scroll"><table class="data">
<thead><tr>${columns.map((column) => `<th scope="col">${esc(column)}</th>`).join('')}</tr></thead>
<tbody>${rows
  .map(
    (row) =>
      `<tr>${row
        .map((text, index) =>
          index === 0
            ? `<th scope="row">${esc(text)}</th>`
            : `<td>${esc(text)}</td>`,
        )
        .join('')}</tr>`,
  )
  .join('')}</tbody>
</table></div>`;
// The numbers of a chart, folded below it, so that no value needs a hover.
const tableView = (table: DataTable) =>
  `<details class="table-view"><summary>Table</summary>${tableHtml(table)}</details>`;

const cell = ({ text, tone }: Cell) =>
  tone === 'neutral'
    ? esc(text)
    : `<span class="icon" aria-hidden="true">${tones[tone]}</span>${esc(text)}<span class="sr"> (${tone})</span>`;

// Draws each primitive as plain HTML and inline SVG, and a page as one
// self-contained text with no <html>, <head> or <body> (report ADR 0003).
export class HtmlRenderer implements PrimitiveVisitor<string> {
  render(page: Page): string {
    const sections = page.sections
      .map(
        (section) => `<section class="section" id="${esc(section.id)}">
  <h2>${esc(section.claim)}</h2>
  ${section.primitives.map((primitive) => primitive.accept(this)).join('\n  ')}
</section>`,
      )
      .join('\n');
    return `<meta charset="utf-8">
<title>${esc(page.title)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>${styles}</style>
<main class="page">
<h1>${esc(page.title)}</h1>
${sections}
</main>
<div class="tip" id="tip" role="tooltip" hidden></div>
<script>${script}</script>
`;
  }

  table(table: Table): string {
    return `<div class="table-scroll"><table class="data">
<thead><tr>${table.columns.map((column) => `<th scope="col">${esc(column)}</th>`).join('')}</tr></thead>
<tbody>${table.rows
      .map(
        (row) =>
          `<tr>${row
            .map((item, index) =>
              index === 0
                ? `<th scope="row" data-tone="${item.tone}">${cell(item)}</th>`
                : `<td data-tone="${item.tone}">${cell(item)}</td>`,
            )
            .join('')}</tr>`,
      )
      .join('')}</tbody>
</table></div>`;
  }

  bars(bars: Bars): string {
    const at = (value: number) => percent(share(bars.scale, value));
    const refs = bars.marks
      .map(
        ({ at: value }) =>
          `<span class="bar-ref" style="--x:${at(value)}"></span>`,
      )
      .join('');
    const rows = bars.bars
      .map(({ label, value, ends, tone }) => {
        const whisker =
          ends === undefined
            ? ''
            : `<span class="whisker" style="--a:${at(ends.low)};--b:${at(ends.high)}"></span>`;
        const interval =
          ends === undefined
            ? ''
            : ` <small>[${fixed(ends.low)}, ${fixed(ends.high)}]</small>`;
        const icon =
          tone === 'neutral'
            ? ''
            : ` <span class="icon" aria-hidden="true">${tones[tone]}</span><span class="sr">(${tone})</span>`;
        const tipRows: TipRow[] = [
          [withEnds(value, ends), label],
          ...bars.marks.map(({ label: mark, at: where }): TipRow => [
            short(where),
            mark,
          ]),
        ];
        return `<div class="bar-row" tabindex="0"${tip(label, tipRows)}>
  <span class="bar-name">${esc(label)}</span>
  <span class="bar-track"><span class="bar" style="--x:${at(value)}"></span>${whisker}${refs}</span>
  <span class="bar-value" data-tone="${tone}">${fixed(value)}${interval}${icon}</span>
</div>`;
      })
      .join('');
    const axis = (className: string, items: readonly string[]) =>
      `<div class="bar-axis" aria-hidden="true"><span></span><span class="${className}">${items.join('')}</span><span></span></div>`;
    const markLabels =
      bars.marks.length === 0
        ? ''
        : axis(
            'ref-labels',
            bars.marks.map(
              ({ label, at: value }) =>
                `<span style="--x:${at(value)}">${esc(label)} ${short(value)}</span>`,
            ),
          );
    const tickLabels = axis(
      'bar-ticks',
      ticks(bars.scale).map(
        (value) => `<span style="--x:${at(value)}">${short(value)}</span>`,
      ),
    );
    const markTable =
      bars.marks.length === 0 ? '' : tableHtml(marksTable(bars));
    return `<figure class="chart">
<div class="bars">${markLabels}${rows}${tickLabels}</div>
<details class="table-view"><summary>Table</summary>${tableHtml(barsTable(bars))}${markTable}</details>
</figure>`;
  }

  scatter(scatter: Scatter): string {
    const scale = domain(scatter.points.flatMap(({ x, y }) => [x, y]));
    const across = (value: number) => percent(share(scale, value));
    const down = (value: number) => percent(1 - share(scale, value));
    const grid = ticks(scale)
      .map(
        (value) =>
          `<div class="gridline" style="--y:${down(value)}"><span>${short(value)}</span></div><div class="vline" style="--x:${across(value)}"></div>`,
      )
      .join('');
    const points = scatter.points
      .map(
        ({ label, x, y }) =>
          `<span class="point" tabindex="0" style="--x:${across(x)};--y:${down(y)}"${tip(
            label,
            [
              [fixed(x), scatter.x],
              [fixed(y), scatter.y],
            ],
          )}></span>`,
      )
      .join('');
    return `<figure class="chart">
<div class="frame square">
  <p class="axis-title">${esc(scatter.y)} ↑</p>
  <div class="plot square">
    ${grid}
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><line class="diagonal" x1="0" y1="100" x2="100" y2="0" vector-effect="non-scaling-stroke"/></svg>
    <span class="diagonal-label" aria-hidden="true">y = x</span>
    ${points}
  </div>
  <div class="x-ticks" aria-hidden="true">${ticks(scale)
    .map((value) => `<span style="--x:${across(value)}">${short(value)}</span>`)
    .join('')}</div>
  <p class="axis-title x">${esc(scatter.x)} →</p>
</div>
${tableView(scatterTable(scatter))}
</figure>`;
  }

  line(line: Line): string {
    const scale = domain(
      line.series.flatMap(({ values }) =>
        values.flatMap(({ value, ends }) =>
          ends === undefined ? [value] : [value, ends.low, ends.high],
        ),
      ),
    );
    const count = line.steps.length;
    const x = (index: number) =>
      count === 1 ? 50 : (index / (count - 1)) * 100;
    const y = (value: number) => (1 - share(scale, value)) * 100;
    // A missing value (NaN) leaves a gap: the pen moves to the next known
    // point instead of drawing to it.
    const coordinates = (points: readonly (readonly [number, number])[]) =>
      points
        .flatMap(([px, py], index) =>
          Number.isNaN(py)
            ? []
            : [
                `${Number.isNaN(points[index - 1]?.[1] ?? Number.NaN) ? 'M' : 'L'}${px.toFixed(2)} ${py.toFixed(2)}`,
              ],
        )
        .join(' ');
    const drawn = line.series
      .map(({ values }, index) => {
        // An interval with no known end leaves a gap in the band, as a
        // missing value does in the line: one closed area between each two
        // neighbouring steps that both have known ends.
        const known = values.map(({ ends }) =>
          ends === undefined ||
          Number.isNaN(ends.low) ||
          Number.isNaN(ends.high)
            ? undefined
            : ends,
        );
        const areas = known.flatMap((ends, step) => {
          const next = known[step + 1];
          return ends === undefined || next === undefined
            ? []
            : [
                `${coordinates([
                  [x(step), y(ends.high)],
                  [x(step + 1), y(next.high)],
                  [x(step + 1), y(next.low)],
                  [x(step), y(ends.low)],
                ])} Z`,
              ];
        });
        const band =
          areas.length === 0
            ? ''
            : `<path class="ends-band" d="${areas.join(' ')}"/>`;
        const path = `<path class="line" d="${coordinates(
          values.map(({ value }, step): [number, number] => [
            x(step),
            y(value),
          ]),
        )}" vector-effect="non-scaling-stroke"/>`;
        return `<g data-series="${slot(index)}">${band}${path}</g>`;
      })
      .join('');
    const dots = line.series
      .flatMap(({ values }, index) =>
        values.flatMap(({ value }, step) =>
          Number.isNaN(value)
            ? []
            : [
                `<span class="dot" data-series="${slot(index)}" style="--x:${x(step).toFixed(2)}%;--y:${y(value).toFixed(2)}%"></span>`,
              ],
        ),
      )
      .join('');
    const steps = line.steps
      .map((step, index) => {
        const from = index === 0 ? 0 : (x(index - 1) + x(index)) / 2;
        const to = index === count - 1 ? 100 : (x(index) + x(index + 1)) / 2;
        const rows = line.series.flatMap(({ label, values }, series) =>
          values
            .slice(index, index + 1)
            .map(({ value, ends }): TipRow => [
              withEnds(value, ends),
              label,
              slot(series),
            ]),
        );
        const hair = ((x(index) - from) / (to - from)) * 100;
        return `<span class="step" tabindex="0" style="--a:${from.toFixed(2)}%;--b:${to.toFixed(2)}%"${tip(step, rows)}><span class="hair" style="--h:${hair.toFixed(2)}%"></span></span>`;
      })
      .join('');
    const grid = ticks(scale)
      .map(
        (value) =>
          `<div class="gridline" style="--y:${y(value).toFixed(2)}%"><span>${short(value)}</span></div>`,
      )
      .join('');
    const legend =
      line.series.length < 2
        ? ''
        : `<ul class="legend">${line.series
            .map(
              ({ label }, index) =>
                `<li data-series="${slot(index)}">${esc(label)}</li>`,
            )
            .join('')}</ul>`;
    return `<figure class="chart">
${legend}
<div class="frame">
  <div class="plot">
    ${grid}
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${drawn}</svg>
    ${dots}
    ${steps}
  </div>
  <div class="x-ticks" aria-hidden="true">${line.steps
    .map(
      (step, index) =>
        `<span style="--x:${x(index).toFixed(2)}%">${esc(step)}</span>`,
    )
    .join('')}</div>
</div>
${tableView(lineTable(line))}
</figure>`;
  }

  heatmap(heatmap: Heatmap): string {
    const head = `<div class="heat-row" aria-hidden="true"><span></span>${heatmap.columns
      .map((column) => `<span class="heat-col">${esc(column)}</span>`)
      .join('')}</div>`;
    const rows = heatmap.rows
      .map(
        (row, index) =>
          `<div class="heat-row"><span class="heat-name">${esc(row)}</span>${heatmap.values
            .slice(index, index + 1)
            .flat()
            .map((value, column) => {
              const name = heatmap.columns.slice(column, column + 1).join('');
              const tipRows: TipRow[] = [[fixed(value), name]];
              const tipAttribute = tip(row, tipRows);
              if (Number.isNaN(value)) {
                return `<span class="heat-cell" data-missing tabindex="0"${tipAttribute}></span>`;
              }
              const shade = Math.min(1, Math.max(0, value)).toFixed(3);
              return `<span class="heat-cell" tabindex="0" style="--v:${shade}"${tipAttribute}></span>`;
            })
            .join('')}</div>`,
      )
      .join('');
    return `<figure class="chart">
<div class="heat-scroll"><div class="heat" style="--cols:${heatmap.columns.length}">${head}${rows}</div></div>
<div class="scale" aria-hidden="true"><span>0</span><span class="scale-bar"></span><span>1</span></div>
${tableView(heatmapTable(heatmap))}
</figure>`;
  }

  valuePairs(pairs: ValuePairs): string {
    const rows = pairs.pairs
      .map((pair) => {
        const { icon, label } = marks[pair.mark];
        const expected = pair.mark === 'only-actual' ? '' : esc(pair.expected);
        const actual = pair.mark === 'only-expected' ? '' : esc(pair.actual);
        return `<tr data-mark="${pair.mark}"><th scope="row"><code>${esc(pair.path)}</code></th><td>${expected}</td><td>${actual}</td><td class="mark"><span class="icon" aria-hidden="true">${icon}</span>${label}</td></tr>`;
      })
      .join('');
    return `<figure class="chart">
<figcaption class="pairs-title">${esc(pairs.title)}</figcaption>
<div class="table-scroll"><table class="pairs">
<thead><tr><th scope="col">Path</th><th scope="col">Expected</th><th scope="col">Actual</th><th scope="col">Mark</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
</figure>`;
  }

  note(note: Note): string {
    return `<p class="note">${esc(note.text)}</p>`;
  }
}
