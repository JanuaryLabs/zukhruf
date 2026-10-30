import type { ModelScores, ReportData, SplitReport } from './report.ts';
import { script } from './script.ts';
import { styles } from './styles.ts';
import type { Verdict } from './verdicts.ts';

// The HTML of Report.toHtml. Each section title is a claim, and the chart
// below it shows the numbers behind the claim, with the same numbers as a
// table. The titles come from the numbers, so new results change them too.
// The page has no <html>, <head> or <body>: a browser opens it as is, and an
// artifact on claude.ai wraps it in its own.

type Role = 'best' | 'baseline' | 'other';
type TipRow = readonly [value: string, label: string, key?: Role | 'reach'];

// A pair of models and its verdict on each tested score.
type Pair = {
  readonly baseline: ModelScores;
  readonly change: ModelScores;
  readonly verdicts: ReadonlyMap<string, Verdict>;
};

type View = {
  readonly report: ReportData;
  readonly split: SplitReport;
  readonly name: string;
  readonly main: string;
  // The models, best main score first; a model without a main score last.
  readonly ranked: readonly ModelScores[];
  // The models that share the best main score.
  readonly top: readonly ModelScores[];
  readonly best: ModelScores;
  readonly baseline: ModelScores;
  // The best model other than the baseline: the claims that compare a model
  // with the baseline use it.
  readonly challenger: ModelScores | undefined;
  readonly role: (model: ModelScores) => Role;
  readonly pairs: readonly Pair[];
  readonly versusBaseline: (model: ModelScores) => Pair | undefined;
  // The score that the claims about chance use: the main score when it is
  // tested, else the first tested score.
  readonly lead: string;
};

const esc = (text: string) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
// A number that a result does not have shows as a dash.
const known = (format: (value: number) => string) => (value: number) =>
  Number.isNaN(value) ? '—' : format(value);
const fixed = known((value) => value.toFixed(3));
const percent = known((value) => `${Math.round(value * 100)}%`);
const at = (value: number) =>
  `${((Number.isNaN(value) ? 0 : value) * 100).toFixed(2)}%`;
const signed = (value: number, digits: number) => {
  if (Number.isNaN(value)) return '—';
  const size = Math.abs(value).toFixed(digits);
  // A value that rounds to 0 keeps its sign, so its side of 0 shows.
  if (value === 0) return size;
  return `${value > 0 ? '+' : '−'}${size}`;
};
// The bootstrap p-value has steps of 1/1000 for 2000 resamples.
const pValue = (value: number) =>
  value < 0.001 ? '< 0.001' : value.toFixed(3);
const day = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const verb = (count: number, one: string, many: string) =>
  count === 1 ? one : many;
const models = (count: number) => `${count} ${verb(count, 'model', 'models')}`;
// The verb of "count of total models": singular for 1 of them or 1 in all.
const verbOf = (count: number, total: number, one: string, many: string) =>
  count === 1 || total === 1 ? one : many;
const names = (list: readonly ModelScores[]) =>
  list.map((model) => esc(model.label)).join(' and ');
const tip = (title: string, rows: readonly TipRow[]) =>
  ` data-tip="${esc(JSON.stringify({ title, rows }))}"`;
const scoreOf = (model: ModelScores, score: string) =>
  model.scores.get(score) ?? Number.NaN;
// Descending order; a missing number is last.
const descending =
  (score: (model: ModelScores) => number) =>
  (a: ModelScores, b: ModelScores) => {
    const [x, y] = [score(a), score(b)];
    return Number.isNaN(x) ? 1 : Number.isNaN(y) ? -1 : y - x;
  };

// The label of a score of the scores dict: ndcg_at_10 is nDCG@10.
const LABELS = [
  ['ndcg_at_', 'nDCG@'],
  ['map_at_', 'MAP@'],
  ['recall_at_', 'Recall@'],
  ['precision_at_', 'Precision@'],
  ['mrr_at_', 'MRR@'],
  ['hit_rate_at_', 'Hit rate@'],
] as const;
const label = (score: string) => {
  for (const [prefix, name] of LABELS)
    if (score.startsWith(prefix))
      return esc(`${name}${score.slice(prefix.length)}`);
  return esc(score);
};
// A share of the relevant documents or of the results; it shows as a
// percent, and its changes as points.
const isShare = (score: string) =>
  /^(recall|precision|hit_rate)_at_/.test(score);
const value = (score: string, number: number) =>
  isShare(score) ? percent(number) : fixed(number);
const changeNumber = (score: string, number: number) =>
  isShare(score) ? signed(number * 100, 1) : signed(number, 3);
const change = (score: string, number: number) =>
  `${changeNumber(score, number)}${isShare(score) ? ' pts' : ''}`;
const interval = (score: string, verdict: Verdict) =>
  `${changeNumber(score, verdict.low)} to ${changeNumber(score, verdict.high)}${isShare(score) ? ' pts' : ''}`;
// A number as the page rounds it: a share to a whole percent, a score to 3
// decimals. The ties and orders that the page states use it, so what it says
// matches what it shows.
const shown = (score: string, number: number) =>
  isShare(score) ? Math.round(number * 100) : Math.round(number * 1000);
// A comparison whose own p-value is below 0.05, which is unclear only after
// the correction for the number of comparisons.
const clearsAlone = (verdict: Verdict) =>
  verdict.result === 'inconclusive' && !verdict.primary && verdict.p < 0.05;
const axis = (score: string) =>
  `${label(score)} change${isShare(score) ? ', points' : ''}`;
// A recall at a cut-off above the size of the corpus is 1 for each model.
const shows = (score: string, documents: number) =>
  !score.startsWith('recall_at_') ||
  Number(score.slice('recall_at_'.length)) <= documents;

const results = {
  better: { icon: '▲', word: 'Better' },
  worse: { icon: '▼', word: 'Worse' },
  inconclusive: { icon: '', word: 'Unclear' },
} as const satisfies Record<Verdict['result'], unknown>;

const section = (eyebrow: string, claim: string, body: string) => `
<section class="section">
  <header class="section-head">
    <p class="eyebrow">${eyebrow}</p>
    <h2>${claim}</h2>
  </header>
  ${body}
</section>`;

const legend = (items: readonly (readonly [Role | 'reach', string])[]) =>
  `<ul class="legend">${items
    .map(([role, text]) => `<li data-role="${role}">${esc(text)}</li>`)
    .join('')}</ul>`;

const tableView = (
  head: readonly string[],
  rows: readonly (readonly string[])[],
) => `
<details class="table-view">
  <summary>Show as table</summary>
  <div class="table-scroll"><table>
    <thead><tr>${head.map((cell) => `<th scope="col">${cell}</th>`).join('')}</tr></thead>
    <tbody>${rows
      .map(
        (row) =>
          `<tr>${row
            .map((cell, index) =>
              index === 0 ? `<th scope="row">${cell}</th>` : `<td>${cell}</td>`,
            )
            .join('')}</tr>`,
      )
      .join('')}</tbody>
  </table></div>
</details>`;

function hero(view: View): string {
  const { report, split, name, main, top, best, baseline, challenger, lead } =
    view;
  const versus =
    challenger === undefined ? undefined : view.versusBaseline(challenger);
  const rivals = view.pairs.filter((pair) => pair.baseline === baseline);
  const beat = rivals.filter(
    (pair) => pair.verdicts.get(lead)?.result === 'better',
  ).length;
  const verdictOnMain = versus?.verdicts.get(main);
  const gain =
    verdictOnMain === undefined || challenger === undefined
      ? ''
      : verdictOnMain.result === 'better'
        ? ` The gain of ${esc(challenger.label)} is more than chance.`
        : verdictOnMain.result === 'worse'
          ? ` ${esc(challenger.label)} is worse beyond chance.`
          : ` The difference of ${esc(challenger.label)} can be chance.`;
  const delta = (score: string) => {
    const verdict = versus?.verdicts.get(score);
    if (verdict === undefined || challenger === undefined) return '';
    return `<p class="tile-delta" data-result="${verdict.result}">${results[verdict.result].icon} ${change(score, verdict.observed)} vs the baseline</p>
      <p class="tile-note">${esc(challenger.label)} · 95% interval ${interval(score, verdict)}${clearsAlone(verdict) ? ` · p ${pValue(verdict.p)} alone, unclear after the correction` : ''}</p>`;
  };
  const headline =
    top.length > 1
      ? `${names(top)} tie for the highest ${label(main)}`
      : `${esc(best.label)} has the highest ${label(main)}`;
  const lede =
    best === baseline
      ? `On ${split.queries.length} queries, the baseline scores ${value(main, scoreOf(baseline, main))} ${label(main)}${challenger === undefined ? '' : `. The best other model, ${esc(challenger.label)}, scores ${value(main, scoreOf(challenger, main))}`}.${gain}`
      : `On ${split.queries.length} queries, ${top.length > 1 ? 'they score' : 'it scores'} ${value(main, scoreOf(best, main))} ${label(main)}. The baseline, ${esc(baseline.label)}, scores ${value(main, scoreOf(baseline, main))}.${gain}`;
  const tileModel = challenger ?? best;
  const recall =
    main !== 'recall_at_10' &&
    tileModel.scores.has('recall_at_10') &&
    shows('recall_at_10', split.documents)
      ? `<div class="tile">
      <p class="tile-label">Relevant documents in the top 10, Recall@10</p>
      <p class="tile-value">${percent(scoreOf(tileModel, 'recall_at_10'))}</p>
      ${delta('recall_at_10')}
    </div>`
      : '';
  const scored =
    report.scoredAt === null
      ? ''
      : ` · last scored ${day.format(report.scoredAt)}`;
  return `
<header class="hero">
  <p class="eyebrow">${esc(report.task.name)} · ${esc(name)}</p>
  <h1>${headline}</h1>
  <p class="lede">${lede}</p>
  <p class="meta">${split.documents} documents · dataset revision ${esc(report.task.revision)}${scored}</p>
  <div class="tiles">
    <div class="tile">
      <p class="tile-label">${label(main)}${tileModel === best ? '' : ` of ${esc(tileModel.label)}`}</p>
      <p class="tile-value">${value(main, scoreOf(tileModel, main))}</p>
      ${delta(main)}
    </div>
    ${recall}
    <div class="tile">
      <p class="tile-label">Models that beat the baseline beyond chance</p>
      <p class="tile-value">${beat} of ${rivals.length}</p>
      <p class="tile-note">on ${label(lead)}</p>
    </div>
  </div>
</header>`;
}

function ranking(view: View): string {
  const { split, main, ranked, best, baseline, role } = view;
  const rivals = ranked.filter((model) => model !== baseline);
  const above = rivals.filter(
    (model) =>
      shown(main, scoreOf(model, main)) > shown(main, scoreOf(baseline, main)),
  ).length;
  // The badges and the claim use the verdicts on the main score, as the bars.
  const verdictOf = (model: ModelScores) =>
    view.versusBaseline(model)?.verdicts.get(main);
  const beyond = rivals.filter(
    (model) => verdictOf(model)?.result === 'better',
  ).length;
  const chance = split.tested.includes(main)
    ? `; ${beyond} ${verb(beyond, 'beats', 'beat')} it by more than chance`
    : '';
  const rows = ranked.map((model) => {
    const verdict = verdictOf(model);
    const tipRows: TipRow[] = [main, 'recall_at_10', 'mrr_at_10']
      .filter(
        (score, index, all) =>
          all.indexOf(score) === index &&
          model.scores.has(score) &&
          shows(score, split.documents),
      )
      .map((score) => [value(score, scoreOf(model, score)), label(score)]);
    if (verdict !== undefined)
      tipRows.push([
        change(main, verdict.observed),
        `vs the baseline · ${results[verdict.result].word}`,
      ]);
    const badge =
      verdict === undefined || verdict.result === 'inconclusive'
        ? ''
        : `<span class="badge" data-result="${verdict.result}">${results[verdict.result].icon} Beyond chance</span>`;
    const share = scoreOf(model, main);
    return `
    <div class="bar-row" data-role="${role(model)}" tabindex="0"${tip(model.label, tipRows)}>
      <span class="bar-name">${esc(model.label)}</span>
      <span class="bar-track">
        <span class="bar" style="--x:${at(share)}"></span>
        <span class="bar-ref" style="--x:${at(scoreOf(baseline, main))}"></span>
        <span class="bar-value" style="--x:${at(share)}">${value(main, share)}</span>
      </span>
      <span class="bar-badge">${badge}</span>
    </div>`;
  });
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1]
    .map(
      (number) =>
        `<span style="--x:${at(number)}">${number === 0 ? '0' : number.toFixed(1)}</span>`,
    )
    .join('');
  return section(
    `Ranking · ${label(main)}`,
    `${above} of ${models(rivals.length)} ${verbOf(above, rivals.length, 'scores', 'score')} above the baseline${chance}.`,
    `${legend([
      ['best', best.label],
      ['baseline', `${baseline.label} (baseline)`],
      ['other', 'Other models'],
    ])}
    <div class="bars">
      ${rows.join('')}
      <div class="bar-axis" aria-hidden="true"><span></span><span class="bar-ticks">${ticks}</span><span></span></div>
    </div>`,
  );
}

// A scale that is the same on both sides of 0, wide enough for each
// interval, so 0 is in the middle of each track: at most 3 ticks on each
// side, at a round step.
const STEPS = [0.05, 0.1, 0.2, 0.25, 0.5, 1];
function scale(reach: number) {
  const step = STEPS.find((candidate) => reach / candidate <= 3) ?? 1;
  const steps = Math.max(1, Math.ceil(reach / step));
  return {
    step,
    x: (number: number) => at((number + steps * step) / (2 * steps * step)),
    ticks: Array.from(
      { length: 2 * steps + 1 },
      (_, index) => (index - steps) * step,
    ),
  };
}

function chance(view: View): string {
  const { split, baseline } = view;
  const { tested } = split;
  const groups = [
    [
      'Against the baseline',
      view.pairs
        .filter((pair) => pair.baseline === baseline)
        .toSorted(
          (a, b) =>
            (b.verdicts.get(view.lead)?.observed ?? 0) -
            (a.verdicts.get(view.lead)?.observed ?? 0),
        ),
    ],
    [
      'Other comparisons',
      view.pairs.filter((pair) => pair.baseline !== baseline),
    ],
  ] as const;
  const domain = (score: string) =>
    scale(
      Math.max(
        0.05,
        ...view.pairs.flatMap(({ verdicts }) => {
          const verdict = verdicts.get(score);
          return verdict === undefined
            ? []
            : [Math.abs(verdict.low), Math.abs(verdict.high)].filter(
                Number.isFinite,
              );
        }),
      ),
    );
  const tick = (score: string, number: number, step: number) =>
    isShare(score)
      ? signed(number * 100, 0)
      : signed(number, step === 0.05 || step === 0.25 ? 2 : 1);
  const primaryScore = (pair: Pair) =>
    [...pair.verdicts.values()].find((verdict) => verdict.primary)?.score;
  const cell = (pair: Pair, score: string) => {
    const verdict = pair.verdicts.get(score);
    if (verdict === undefined) return '<span></span><span></span>';
    const { x } = domain(score);
    const rows: TipRow[] = [
      [change(score, verdict.observed), `${label(score)} change`],
      [interval(score, verdict), '95% interval'],
      [
        `p ${pValue(verdict.p)} · deciding p ${pValue(verdict.decidingP)}`,
        verdict.primary
          ? 'Primary comparison, tested alone'
          : 'Holm-adjusted across the comparisons',
      ],
      [
        results[verdict.result].word,
        `${verdict.queries} queries, ${verdict.replicates.toLocaleString('en')} resamples`,
      ],
    ];
    return `
      <span class="f-track" data-result="${verdict.result}"${clearsAlone(verdict) ? ' data-alone' : ''} tabindex="0"${tip(`${pair.change.label} vs ${pair.baseline.label}`, rows)}>
        <span class="f-ci" style="--a:${x(verdict.low)};--b:${x(verdict.high)}"></span>
        <span class="f-dot" style="--x:${x(verdict.observed)}"></span>
      </span>
      <span class="f-value" data-result="${verdict.result}">${results[verdict.result].icon} ${changeNumber(score, verdict.observed)}<small>${changeNumber(score, verdict.low)} to ${changeNumber(score, verdict.high)}</small></span>`;
  };
  const beat = (score: string) =>
    groups[0][1].filter((pair) => pair.verdicts.get(score)?.result === 'better')
      .length;
  const tag = (pair: Pair) => {
    const score = primaryScore(pair);
    return score === undefined
      ? ''
      : `<span class="tag">primary · ${label(score)}</span>`;
  };
  const body = groups
    .filter(([, pairs]) => pairs.length > 0)
    .map(
      ([title, pairs]) => `
      <p class="f-group">${title}</p>
      ${pairs
        .map(
          (pair) => `
        <div class="f-row">
          <span class="f-name">${esc(pair.change.label)}${tag(pair)}${pair.baseline === baseline ? '' : `<small>vs ${esc(pair.baseline.label)}</small>`}</span>
          ${tested.map((score) => cell(pair, score)).join('')}
        </div>`,
        )
        .join('')}`,
    )
    .join('');
  const ticks = (score: string) => {
    const { x, ticks: values, step } = domain(score);
    return `<span class="f-ticks">${values
      .map(
        (number) =>
          `<span style="--x:${x(number)}">${tick(score, number, step)}</span>`,
      )
      .join('')}</span><span></span>`;
  };
  const [first = view.main, ...others] = tested;
  const alsoBeat = others
    .map((score) => `, and ${beat(score)} on ${label(score)}`)
    .join('');
  return section(
    'More than chance?',
    `${beat(first)} of ${models(groups[0][1].length)} ${verbOf(beat(first), groups[0][1].length, 'beats', 'beat')} the baseline by more than chance on ${label(first)}${alsoBeat}.`,
    `<ul class="legend results">
      <li data-result="better">${results.better.icon} Better, beyond chance</li>
      <li data-result="worse">${results.worse.icon} Worse, beyond chance</li>
      <li data-result="inconclusive">Unclear: the deciding p-value is 0.05 or more</li>${
        view.pairs.some((pair) => [...pair.verdicts.values()].some(clearsAlone))
          ? `
      <li data-result="inconclusive" class="alone">Dashed: its own p-value is below 0.05, but not after the correction for the number of comparisons</li>`
          : ''
      }
    </ul>
    <div class="forest-scroll"><div class="forest" style="--scores:${tested.length}">
      <div class="f-row f-head"><span></span>${tested.map((score) => `<span>${axis(score)}</span><span></span>`).join('')}</div>
      ${body}
      <div class="f-row f-axis" aria-hidden="true"><span></span>${tested.map(ticks).join('')}</div>
    </div></div>
    ${tableView(
      [
        'Comparison',
        ...tested.flatMap((score) => [
          axis(score),
          '95% interval',
          'Deciding p',
          'Result',
        ]),
      ],
      view.pairs.map((pair) => {
        const score = primaryScore(pair);
        return [
          `${esc(pair.change.label)} vs ${esc(pair.baseline.label)}${score === undefined ? '' : ` (primary on ${label(score)})`}`,
          ...tested.flatMap((tested) => {
            const verdict = pair.verdicts.get(tested);
            return verdict === undefined
              ? ['', '', '', '']
              : [
                  change(tested, verdict.observed),
                  interval(tested, verdict),
                  pValue(verdict.decidingP),
                  results[verdict.result].word,
                ];
          }),
        ];
      }),
    )}`,
  );
}

function depth(view: View): string {
  const { split, ranked, best, baseline, role } = view;
  const { depths, bestRecall } = split;
  const recallAt = (model: ModelScores, k: number) =>
    scoreOf(model, `recall_at_${k}`);
  const deepest = Math.max(...depths);
  const near = depths.includes(10) ? 10 : (depths.at(-1) ?? deepest);
  const x = (k: number) =>
    deepest === 1 ? 0 : (Math.log10(k) / Math.log10(deepest)) * 100;
  const y = (number: number) => (1 - (Number.isNaN(number) ? 0 : number)) * 100;
  const line = (values: (k: number) => number) =>
    depths
      .map(
        (k, index) =>
          `${index === 0 ? 'M' : 'L'}${x(k).toFixed(2)} ${y(values(k)).toFixed(2)}`,
      )
      .join(' ');
  const possible = (k: number) => bestRecall.get(k) ?? Number.NaN;
  const outOfReach = `M0 0 L100 0 ${depths
    .toReversed()
    .map((k) => `L${x(k).toFixed(2)} ${y(possible(k)).toFixed(2)}`)
    .join(' ')} Z`;
  const layer = { other: 0, baseline: 1, best: 2 } as const;
  const drawn = ranked.toSorted((a, b) => layer[role(a)] - layer[role(b)]);
  const marks = drawn
    .filter((model) => role(model) !== 'other')
    .flatMap((model) =>
      depths.map(
        (k) =>
          `<span class="mark" data-role="${role(model)}" style="--x:${x(k).toFixed(2)}%;--y:${y(recallAt(model, k)).toFixed(2)}%"></span>`,
      ),
    )
    .join('');
  const bands = depths
    .map((k, index) => {
      const from = index === 0 ? 0 : (x(depths[index - 1] ?? k) + x(k)) / 2;
      const to =
        index === depths.length - 1
          ? 100
          : (x(k) + x(depths[index + 1] ?? k)) / 2;
      const rows: TipRow[] = ranked
        .toSorted(descending((model) => recallAt(model, k)))
        .map((model) => [
          percent(recallAt(model, k)),
          model.label,
          role(model),
        ]);
      rows.push([percent(possible(k)), 'Best possible', 'reach']);
      const hair = to === from ? 0 : ((x(k) - from) / (to - from)) * 100;
      return `<span class="band" tabindex="0" style="--a:${from.toFixed(2)}%;--b:${to.toFixed(2)}%"${tip(`Top ${k}`, rows)}><span class="hair" style="--h:${hair.toFixed(2)}%"></span></span>`;
    })
    .join('');
  const gridlines = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (number) =>
        `<span class="gridline" style="--y:${y(number)}%"><span>${percent(number)}</span></span>`,
    )
    .join('');
  const note =
    possible(near) < 1
      ? `<p class="note">A perfect ranking puts ${percent(possible(near))} of the relevant documents of a query in its top ${near}, on average over the queries: a query with more than ${near} relevant documents cannot have them all there. A query has ${split.relevantPerQuery.toFixed(1)} relevant documents on average.</p>`
      : '';
  return section(
    'Depth · Recall@k',
    `${esc(best.label)} has ${percent(recallAt(best, near))} of the relevant documents of a query in its top ${near}${near === deepest ? '' : `, and ${percent(recallAt(best, deepest))} in its top ${deepest}`}, on average over the queries.`,
    `${note}
    ${legend([
      ['best', best.label],
      ['baseline', `${baseline.label} (baseline)`],
      ['other', 'Other models'],
      ['reach', 'Out of reach: more relevant documents than results'],
    ])}
    <figure class="recall">
      <div class="plot">
        ${gridlines}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path class="reach" d="${outOfReach}"></path>
          <path class="reach-edge" d="${line(possible)}" vector-effect="non-scaling-stroke"></path>
          ${drawn
            .map(
              (model) =>
                `<path class="line" data-role="${role(model)}" d="${line((k) => recallAt(model, k))}" vector-effect="non-scaling-stroke"></path>`,
            )
            .join('')}
        </svg>
        ${marks}
        ${bands}
      </div>
      <div class="x-ticks" aria-hidden="true">${depths
        .map((k) => `<span style="--x:${x(k).toFixed(2)}%">${k}</span>`)
        .join('')}</div>
      <figcaption>Results read, top k (log scale)</figcaption>
    </figure>
    ${tableView(
      ['Model', ...depths.map((k) => `Top ${k}`)],
      [
        ...ranked.map((model) => [
          esc(model.label),
          ...depths.map((k) => percent(recallAt(model, k))),
        ]),
        ['Best possible', ...depths.map((k) => percent(possible(k)))],
      ],
    )}`,
  );
}

function queries(view: View): string {
  const { split, ranked, baseline, challenger, role } = view;
  const score = split.queryScore;
  const scoreAt = (model: ModelScores, id: string) =>
    model.perQuery.get(id) ?? Number.NaN;
  const rival = challenger ?? baseline;
  const gain = (id: string) => scoreAt(rival, id) - scoreAt(baseline, id);
  // Two scores that are the same to three digits are a tie.
  const sign = (number: number) =>
    Number.isNaN(number) || Math.abs(number) < 0.0005
      ? 'flat'
      : number > 0
        ? 'up'
        : 'down';
  const rows = split.queries.toSorted(
    (a, b) => gain(b.id) - gain(a.id) || a.id.localeCompare(b.id),
  );
  const tally = (wanted: string) =>
    rows.filter(({ id }) => sign(gain(id)) === wanted).length;
  const grid = rows
    .map(({ id, text }) => {
      const cells = ranked
        .map((model) => {
          const cell = scoreAt(model, id);
          const tipRows: TipRow[] = [[fixed(cell), model.label, role(model)]];
          if (model !== baseline)
            tipRows.push([
              signed(cell - scoreAt(baseline, id), 3),
              `vs ${baseline.label}`,
            ]);
          return `<span class="heat-cell" style="--v:${(Number.isNaN(cell) ? 0 : cell).toFixed(3)}"${tip(text === '' ? id : `${id} · ${text}`, tipRows)}></span>`;
        })
        .join('');
      const delta = gain(id);
      return `
      <div class="heat-row">
        <span class="heat-q"><span class="q-id">${esc(id)}</span>${esc(text)}</span>
        ${cells}
        <span class="heat-delta" data-sign="${sign(delta)}">${{ up: results.better.icon, down: results.worse.icon, flat: '' }[sign(delta)]} ${sign(delta) === 'flat' ? (0).toFixed(3) : signed(delta, 3)}</span>
      </div>`;
    })
    .join('');
  const claim =
    challenger === undefined
      ? `Only the baseline has scores, on ${rows.length} queries.`
      : `${esc(rival.label)} beats the baseline on ${tally('up')} of ${rows.length} queries, ties on ${tally('flat')} and loses on ${tally('down')}.`;
  return section(
    `Query by query · ${label(score)}`,
    claim,
    `<div class="heat-scroll"><div class="heat" style="--cols:${ranked.length}">
      <div class="heat-row heat-head">
        <span></span>
        ${ranked
          .map(
            (model) =>
              `<span class="heat-col" data-role="${role(model)}"><span>${esc(model.label)}</span></span>`,
          )
          .join('')}
        <span class="heat-col"><span>${esc(rival.label)} vs baseline</span></span>
      </div>
      ${grid}
    </div></div>
    <div class="scale" aria-hidden="true"><span>0</span><span class="scale-bar"></span><span>1</span><span class="scale-label">${label(score)} of each query. Rows are in order of the gain of ${esc(rival.label)}.</span></div>
    ${tableView(
      ['Query', ...ranked.map((model) => esc(model.label))],
      rows.map(({ id, text }) => [
        text === '' ? esc(id) : `${esc(id)} · ${esc(text)}`,
        ...ranked.map((model) => fixed(scoreAt(model, id))),
      ]),
    )}`,
  );
}

// What each kind of score means, for the scores in the table.
const TERMS = [
  [
    'ndcg_at_',
    'nDCG@k',
    'How good the first k results are. A more relevant document counts more, and a document near the top counts more than one lower down. 1 is a perfect ranking. The mean over the queries.',
  ],
  [
    'recall_at_',
    'Recall@k',
    'The share of the relevant documents of a query that are in the first k results, averaged over the queries.',
  ],
  [
    'mrr_at_',
    'MRR@k',
    'How high the first relevant document is: 1 for first place, 0.5 for second place, 0 when none is in the first k results; averaged over the queries.',
  ],
  [
    'map_at_',
    'MAP@k',
    'The mean of the precision at the rank of each relevant document in the first k results, averaged over the queries.',
  ],
] as const;

function scoreTable(view: View): string {
  const { split, main, ranked, best, baseline, role } = view;
  const columns = [main, 'recall_at_10', 'recall_at_100', 'mrr_at_10'].filter(
    (score, index, all) =>
      all.indexOf(score) === index &&
      baseline.scores.has(score) &&
      shows(score, split.documents),
  );
  // The models with the best value of each score; more than one is a tie.
  const leaders = columns.map((score) => {
    const top = Math.max(
      ...ranked
        .map((model) => shown(score, scoreOf(model, score)))
        .filter(Number.isFinite),
    );
    return {
      score,
      leaders: ranked.filter(
        (model) => shown(score, scoreOf(model, score)) === top,
      ),
    };
  });
  const led = leaders.filter(
    ({ leaders: list }) => list.length === 1 && list[0] === best,
  ).length;
  // The other leaders, one sentence for each model or tie, with its scores.
  const groups = new Map<string, { list: ModelScores[]; scores: string[] }>();
  for (const { score, leaders: list } of leaders) {
    if (list.length === 1 && list[0] === best) continue;
    const key = list.map((model) => model.label).join('\n');
    const group = groups.get(key) ?? { list, scores: [] };
    group.scores.push(label(score));
    groups.set(key, group);
  }
  const others = [...groups.values()]
    .map(
      ({ list, scores }) =>
        ` ${names(list)} ${list.length === 1 ? 'leads' : 'tie'} on ${scores.join(' and ')}.`,
    )
    .join('');
  const terms = TERMS.filter(([prefix]) =>
    columns.some((score) => score.startsWith(prefix)),
  );
  return section(
    'All scores',
    led > 0
      ? `${esc(best.label)} leads on ${led} of ${columns.length} scores.${others}`
      : others.trim(),
    `<div class="table-scroll"><table class="scores">
      <thead><tr><th scope="col">Model</th>${columns.map((score) => `<th scope="col">${label(score)}</th>`).join('')}</tr></thead>
      <tbody>${ranked
        .map(
          (model) => `<tr data-role="${role(model)}">
          <th scope="row">${esc(model.label)}${model === baseline ? ' <span class="tag">baseline</span>' : ''}</th>
          ${columns
            .map((score, index) => {
              const text = value(score, scoreOf(model, score));
              return `<td>${leaders[index]?.leaders.includes(model) ? `<strong>${text}</strong>` : text}</td>`;
            })
            .join('')}
        </tr>`,
        )
        .join('')}</tbody>
    </table></div>
    <dl class="terms">
      ${terms.map(([, name, text]) => `<div><dt>${name}</dt><dd>${text}</dd></div>`).join('')}
      <div><dt>95% interval</dt><dd>The likely range of the true difference: the queries are resampled many times. A difference counts when its deciding p-value is below 0.05.</dd></div>
    </dl>`,
  );
}

function method(view: View): string {
  const { report, split } = view;
  const replicates = split.verdicts[0]?.replicates.toLocaleString('en') ?? 'no';
  const { primary } = report;
  const labelOf = (model: ModelScores['model']) =>
    esc(split.models.find((entry) => entry.model === model)?.label ?? '');
  const holm =
    primary === undefined
      ? 'Holm-Bonferroni adjusts the p-values of all the comparisons as one family.'
      : `The primary comparison, ${labelOf(primary.change)} vs ${labelOf(primary.baseline)} on ${label(primary.score)}, is tested alone. Holm-Bonferroni adjusts the p-values of the other comparisons as one family.`;
  const { reference } = report.task;
  const link =
    reference !== null && /^https?:\/\//i.test(reference)
      ? ` <a href="${esc(reference)}">Reference</a>.`
      : '';
  const scored = split.queries.length;
  const queriesNote = `${
    split.allQueries > scored
      ? `The ${esc(view.name)} split has ${split.allQueries} queries; ${scored} of them have judgments, and they count.`
      : `The ${esc(view.name)} split has ${scored} queries, each with judgments, and each counts.`
  }${
    split.withRelevant < scored
      ? ` ${scored - split.withRelevant} of them have no relevant document and score 0 for each model, as in MTEB.`
      : ''
  }`;
  return section(
    'Method',
    'How the models were tested',
    `<div class="method">
      <dl class="terms">
        <div><dt>Task</dt><dd>${esc(report.task.name)}: ${esc(report.task.description)}${link}</dd></div>
        <div><dt>Queries</dt><dd>${queriesNote}</dd></div>
        <div><dt>Documents</dt><dd>${split.documents} documents, dataset revision ${esc(report.task.revision)}. A query has ${split.relevantPerQuery.toFixed(1)} relevant documents on average.</dd></div>
        <div><dt>Chance</dt><dd>A paired bootstrap over the queries: ${replicates} resamples, 95% interval. ${holm} A difference counts when its deciding p-value is below 0.05.</dd></div>
      </dl>
    </div>`,
  );
}

const nameOf = (split: SplitReport) =>
  split.subset === 'default' ? split.split : `${split.split} · ${split.subset}`;

function viewOf(report: ReportData, split: SplitReport): View {
  const main = report.task.mainScore;
  const ranked = split.models.toSorted(
    descending((model) => scoreOf(model, main)),
  );
  const best = ranked[0] ?? split.baseline;
  const top = ranked.filter(
    (model) =>
      !Number.isNaN(scoreOf(model, main)) &&
      shown(main, scoreOf(model, main)) === shown(main, scoreOf(best, main)),
  );
  const byModel = new Map(split.models.map((entry) => [entry.model, entry]));
  const pairs: Pair[] = [];
  for (const verdict of split.verdicts) {
    const baseline = byModel.get(verdict.baseline);
    const change = byModel.get(verdict.change);
    if (baseline === undefined || change === undefined) continue;
    const index = pairs.findIndex(
      (pair) => pair.baseline === baseline && pair.change === change,
    );
    const pair = pairs[index];
    if (pair === undefined)
      pairs.push({
        baseline,
        change,
        verdicts: new Map([[verdict.score, verdict]]),
      });
    else
      pairs[index] = {
        ...pair,
        verdicts: new Map([...pair.verdicts, [verdict.score, verdict]]),
      };
  }
  return {
    report,
    split,
    name: nameOf(split),
    main,
    ranked,
    top,
    best,
    baseline: split.baseline,
    challenger: ranked.find((model) => model !== split.baseline),
    role: (model) =>
      model === split.baseline
        ? 'baseline'
        : top.includes(model)
          ? 'best'
          : 'other',
    pairs,
    versusBaseline: (model) =>
      pairs.find(
        (pair) => pair.baseline === split.baseline && pair.change === model,
      ),
    lead: split.tested.includes(main) ? main : (split.tested[0] ?? main),
  };
}

export function page(report: ReportData): string {
  const switcher =
    report.splits.length < 2
      ? ''
      : `<nav class="splits" aria-label="Split">${report.splits
          .map(
            (split, index) =>
              `<button type="button" data-split="${index}" aria-pressed="${index === 0}">${esc(nameOf(split))}</button>`,
          )
          .join('')}</nav>`;
  const splits = report.splits
    .map((split, index) => {
      const view = viewOf(report, split);
      return `<div class="split" data-split="${index}"${index === 0 ? '' : ' hidden'}>
  ${hero(view)}
  ${ranking(view)}
  ${chance(view)}
  ${depth(view)}
  ${queries(view)}
  ${scoreTable(view)}
  ${method(view)}
</div>`;
    })
    .join('');
  const version =
    report.mtebVersion === null ? '' : ` · MTEB ${esc(report.mtebVersion)}`;
  return `<meta charset="utf-8">
<title>${esc(report.task.name)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>${styles}</style>
<main class="page">
  ${switcher}
  ${splits}
  <footer class="footer">Made by @zukhruf/mteb/report from the result cache and the predictions${version}</footer>
</main>
<div class="tip" id="tip" role="tooltip" hidden></div>
<script>${script}</script>
`;
}
