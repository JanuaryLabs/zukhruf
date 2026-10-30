// The CSS of the report page: one 64rem column, a claim above each chart,
// light and dark themes. Role colours: best, baseline, other.
export const styles = `
/* Layout: one 64rem column. A claim heads each section; its chart follows, with its table folded below. */
:root {
  --page: #ffffff;
  --raised: #f4f6f9;
  --ink: #10151c;
  --ink-2: #4a5361;
  --muted: #6c7481;
  --grid: #e6e9ee;
  --axis: #c3c9d2;
  --best: #2a78d6;
  --baseline: #eb6834;
  --other: #c9ced6;
  --good: #0ca30c;
  --good-ink: #006300;
  --bad: #d03b3b;
  --bad-ink: #b3261e;
  --wash: rgba(16, 21, 28, 0.05);
  --ring: rgba(16, 21, 28, 0.12);
  --heat-lo: #eef3fa;
  --heat-hi: #104281;
  --shadow: 0 8px 24px rgba(16, 21, 28, 0.14);
  --sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --page: #101318; --raised: #171b21; --ink: #eef1f4; --ink-2: #b6bdc7; --muted: #8b93a0;
    --grid: #242931; --axis: #3a414b; --best: #3987e5; --baseline: #d95926; --other: #4a515c;
    --good-ink: #0ca30c; --bad-ink: #e66767; --wash: rgba(255, 255, 255, 0.05); --ring: rgba(255, 255, 255, 0.12);
    --heat-lo: #18212d; --heat-hi: #86b6ef; --shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --page: #101318; --raised: #171b21; --ink: #eef1f4; --ink-2: #b6bdc7; --muted: #8b93a0;
  --grid: #242931; --axis: #3a414b; --best: #3987e5; --baseline: #d95926; --other: #4a515c;
  --good-ink: #0ca30c; --bad-ink: #e66767; --wash: rgba(255, 255, 255, 0.05); --ring: rgba(255, 255, 255, 0.12);
  --heat-lo: #18212d; --heat-hi: #86b6ef; --shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 400 1rem/1.55 var(--sans); }
table { font: inherit; color: inherit; border-collapse: collapse; }
p, h1, h2, ul, dl, dd, figure { margin: 0; }
ul { padding: 0; list-style: none; }
[data-role="best"] { --c: var(--best); }
[data-role="baseline"] { --c: var(--baseline); }
[data-role="other"] { --c: var(--other); }
[data-role="reach"] { --c: var(--muted); }
[data-result="better"] { --s: var(--good); --s-ink: var(--good-ink); }
[data-result="worse"] { --s: var(--bad); --s-ink: var(--bad-ink); }
[data-result="inconclusive"] { --s: var(--muted); --s-ink: var(--ink-2); }
:focus-visible { outline: 2px solid var(--best); outline-offset: 2px; }

.page {
  max-width: 64rem; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr); gap: 4rem;
  padding-block: 3.5rem 3rem;
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
}
.eyebrow { font: 500 0.75rem/1.4 var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.hero { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; }
h1 { font-size: clamp(2rem, 5vw, 3.25rem); line-height: 1.06; font-weight: 600; letter-spacing: -0.025em; text-wrap: balance; max-width: 20ch; }
.lede { font-size: 1.1875rem; color: var(--ink-2); max-width: 40rem; text-wrap: pretty; }
.meta { font: 0.8125rem/1.4 var(--mono); color: var(--muted); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1.5rem; margin-top: 1.5rem; }
.tile { border-top: 1px solid var(--axis); padding-top: 0.875rem; display: grid; gap: 0.25rem; align-content: start; }
.tile-label { font-size: 0.8125rem; color: var(--ink-2); }
.tile-value { font-size: 2.75rem; line-height: 1.1; font-weight: 600; letter-spacing: -0.02em; }
.tile-delta { font-size: 0.875rem; font-weight: 500; color: var(--s-ink); }
.tile-note { font-size: 0.75rem; color: var(--muted); }

.section { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1.5rem; border-top: 1px solid var(--grid); padding-top: 2.25rem; }
.section-head { display: grid; gap: 0.5rem; }
h2 { font-size: clamp(1.25rem, 2.6vw, 1.625rem); line-height: 1.25; font-weight: 600; letter-spacing: -0.015em; text-wrap: balance; max-width: 44rem; }
.note { color: var(--ink-2); max-width: 44rem; margin-top: -0.75rem; }
.legend { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; font-size: 0.8125rem; color: var(--ink-2); }
.legend li { display: inline-flex; align-items: center; gap: 0.5rem; }
.legend li[data-role]::before { content: ""; width: 0.875rem; height: 0.5rem; border-radius: 2px; background: var(--c); }
.legend li[data-role="reach"]::before { background: var(--wash); outline: 1px solid var(--ring); outline-offset: -1px; }
.legend.results li { color: var(--s-ink); }

.bars { display: grid; grid-template-columns: minmax(9rem, 14rem) minmax(0, 1fr) 8rem; }
.bar-row, .bar-axis { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: center; }
.bar-row { border-radius: 4px; cursor: default; }
.bar-row:hover, .bar-row:focus-visible { background: var(--wash); }
.bar-name { font-size: 0.875rem; padding: 0 0.75rem 0 0.25rem; }
.bar-row[data-role="best"] .bar-name, .bar-row[data-role="baseline"] .bar-name { font-weight: 600; }
.bar-track {
  position: relative; height: 2.5rem;
  background-image: linear-gradient(to right, var(--grid) 1px, transparent 1px); background-size: 20% 100%;
  border-right: 1px solid var(--grid);
}
.bar { position: absolute; left: 0; top: 50%; translate: 0 -50%; height: 1.25rem; width: var(--x); background: var(--c); border-radius: 0 4px 4px 0; }
.bar-ref { position: absolute; top: 0; bottom: 0; left: var(--x); width: 1.5px; background: var(--baseline); }
.bar-value { position: absolute; left: calc(var(--x) + 0.25rem); top: 50%; translate: 0 -50%; padding-inline: 0.25rem; border-radius: 2px; background: var(--page); font: 500 0.8125rem var(--mono); font-variant-numeric: tabular-nums; }
.bar-row:hover .bar-value, .bar-row:focus-visible .bar-value { background: transparent; }
.bar-badge { padding-left: 0.75rem; }
.badge { font-size: 0.75rem; font-weight: 500; color: var(--s-ink); white-space: nowrap; }
.bar-ticks, .f-ticks, .x-ticks { position: relative; height: 1.5rem; font: 0.75rem var(--mono); color: var(--muted); }
.bar-ticks span, .f-ticks span, .x-ticks span { position: absolute; left: var(--x); translate: -50% 0; top: 0.25rem; white-space: nowrap; }
.lineup { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1rem 1.5rem; margin-top: 0.5rem; }
.lineup dt, .terms dt { font-weight: 600; font-size: 0.875rem; }
.lineup dd, .terms dd { font-size: 0.875rem; color: var(--ink-2); }

.forest-scroll, .heat-scroll, .table-scroll { overflow-x: auto; }
.forest { display: grid; grid-template-columns: minmax(11rem, 14rem) repeat(var(--scores), minmax(8rem, 1fr) 10rem); min-width: calc(14rem + var(--scores) * 19rem); }
.f-row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: center; min-height: 2.75rem; border-bottom: 1px solid var(--grid); }
.f-head, .f-axis { border-bottom: 0; min-height: 0; }
.f-head span { font-size: 0.75rem; color: var(--muted); padding-bottom: 0.25rem; }
.f-group { grid-column: 1 / -1; font-size: 0.8125rem; font-weight: 600; color: var(--ink-2); padding: 1.25rem 0 0.375rem; border-bottom: 1px solid var(--axis); }
.f-name { font-size: 0.875rem; padding: 0.375rem 0.75rem 0.375rem 0; display: grid; }
.f-name small, .f-value small { font-size: 0.75rem; color: var(--muted); font-weight: 400; }
.f-track { position: relative; align-self: stretch; cursor: default; }
.f-track::before { content: ""; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: var(--axis); }
.f-track:hover, .f-track:focus-visible { background: var(--wash); }
.f-ci { position: absolute; top: 50%; height: 2px; translate: 0 -50%; left: var(--a); width: calc(var(--b) - var(--a)); background: var(--s); border-radius: 1px; }
/* Dashed: the interval clears 0 alone, but the result is unclear after the correction. */
.f-track[data-alone] .f-ci { background: repeating-linear-gradient(to right, var(--s) 0 4px, transparent 4px 7px); }
.legend.results li.alone { font-style: italic; }
.f-dot { position: absolute; top: 50%; left: var(--x); width: 10px; height: 10px; translate: -50% -50%; border-radius: 50%; background: var(--s); box-shadow: 0 0 0 2px var(--page); }
.f-track[data-result="inconclusive"] .f-dot { background: var(--page); border: 2px solid var(--muted); }
.f-value { display: grid; padding-left: 0.75rem; font: 500 0.8125rem/1.3 var(--mono); font-variant-numeric: tabular-nums; color: var(--s-ink); }
.f-value[data-result="inconclusive"] { font-weight: 400; }
.f-value small { white-space: nowrap; }

.recall { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.25rem; padding-left: 2.75rem; }
.plot { position: relative; height: 19rem; margin: 0.75rem 0.75rem 0 0.75rem; }
.plot svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.gridline { position: absolute; left: -0.75rem; right: -0.75rem; top: var(--y); height: 1px; background: var(--grid); }
.gridline span { position: absolute; right: calc(100% + 0.5rem); top: 0; translate: 0 -50%; font: 0.75rem var(--mono); color: var(--muted); }
.reach { fill: var(--wash); }
.reach-edge { fill: none; stroke: var(--muted); stroke-width: 1; }
.line { fill: none; stroke: var(--c); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.mark { position: absolute; left: var(--x); top: var(--y); width: 8px; height: 8px; translate: -50% -50%; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 2px var(--page); pointer-events: none; }
.band { position: absolute; top: 0; bottom: 0; left: var(--a); width: calc(var(--b) - var(--a)); }
.hair { position: absolute; top: 0; bottom: 0; left: var(--h); width: 1px; background: var(--ink-2); opacity: 0; }
.band:hover .hair, .band:focus-visible .hair { opacity: 0.6; }
.band:focus-visible { outline-offset: -2px; }
.x-ticks { margin-inline: 0.75rem; }
.recall figcaption { font-size: 0.75rem; color: var(--muted); text-align: center; }

.heat { display: grid; grid-template-columns: minmax(16rem, 2.4fr) repeat(var(--cols), minmax(2.5rem, 1fr)) 5.5rem; gap: 2px; min-width: 46rem; }
.heat-row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; }
.heat-col { display: flex; justify-content: center; align-items: flex-end; padding-bottom: 0.5rem; }
.heat-col span { writing-mode: vertical-rl; rotate: 180deg; font-size: 0.75rem; line-height: 1.2; color: var(--ink-2); max-height: 11rem; }
.heat-col[data-role="best"] span, .heat-col[data-role="baseline"] span { color: var(--ink); font-weight: 600; }
.heat-q { font-size: 0.8125rem; line-height: 1.35; padding: 0.375rem 0.75rem 0.375rem 0; display: flex; gap: 0.5rem; align-items: baseline; }
.q-id { font: 0.6875rem var(--mono); color: var(--muted); flex: none; white-space: nowrap; }
.heat-cell { min-height: 2.25rem; border-radius: 2px; background: color-mix(in oklab, var(--heat-hi) calc(var(--v) * 100%), var(--heat-lo)); }
.heat-cell:hover { outline: 2px solid var(--ink); outline-offset: -2px; }
.heat-delta { align-self: center; justify-self: end; font: 500 0.75rem var(--mono); font-variant-numeric: tabular-nums; color: var(--ink-2); white-space: nowrap; }
.heat-delta[data-sign="up"] { color: var(--good-ink); }
.heat-delta[data-sign="down"] { color: var(--bad-ink); }
.scale { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; font: 0.75rem var(--mono); color: var(--muted); }
.scale-bar { width: 8rem; height: 0.5rem; border-radius: 2px; background: linear-gradient(in oklab to right, var(--heat-lo), var(--heat-hi)); outline: 1px solid var(--ring); outline-offset: -1px; }
.scale-label { font-family: var(--sans); }

.table-view summary { cursor: pointer; font-size: 0.8125rem; color: var(--ink-2); width: fit-content; }
.table-view[open] summary { margin-bottom: 0.75rem; }
table { width: 100%; font-size: 0.8125rem; }
th, td { text-align: right; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--grid); white-space: nowrap; font-variant-numeric: tabular-nums; }
th:first-child { text-align: left; font-weight: 400; white-space: normal; min-width: 12rem; }
thead th { font-size: 0.75rem; font-weight: 500; color: var(--ink-2); background: var(--raised); }
.scores { font-size: 0.9375rem; }
.scores tbody th { font-weight: 500; }
.scores tbody th::before { content: ""; display: inline-block; width: 0.625rem; height: 0.625rem; border-radius: 2px; background: var(--c); margin-right: 0.625rem; }
.scores strong { font-weight: 600; }
.tag { font: 0.6875rem var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-left: 0.375rem; }
.terms { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 1rem 1.5rem; }
.method { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 2rem; }
.method .terms { grid-template-columns: 1fr; }
.limits { display: grid; gap: 0.75rem; align-content: start; background: var(--raised); border-radius: 6px; padding: 1.25rem; }
.limits-title { font-weight: 600; font-size: 0.875rem; }
.limits ul { display: grid; gap: 0.625rem; font-size: 0.875rem; color: var(--ink-2); }
.limits li { padding-left: 1rem; position: relative; }
.limits li::before { content: ""; position: absolute; left: 0; top: 0.6em; width: 0.375rem; height: 1px; background: var(--muted); }
.footer { font: 0.75rem var(--mono); color: var(--muted); border-top: 1px solid var(--grid); padding-top: 1.25rem; }

.tip {
  position: fixed; z-index: 20; pointer-events: none; max-width: 20rem;
  background: var(--page); color: var(--ink); border: 1px solid var(--ring); border-radius: 6px; box-shadow: var(--shadow);
  padding: 0.5rem 0.75rem; font-size: 0.75rem; display: grid; gap: 0.25rem;
}
.tip-title { color: var(--ink-2); font-weight: 500; margin-bottom: 0.125rem; }
.tip-row { display: grid; grid-template-columns: 0.75rem auto 1fr; align-items: center; gap: 0.5rem; }
.tip-row strong { font: 600 0.75rem var(--mono); font-variant-numeric: tabular-nums; }
.tip-row span:last-child { color: var(--ink-2); }
.tip-key { height: 2px; border-radius: 1px; background: var(--c, transparent); }

@media (max-width: 40rem) {
  .bars { grid-template-columns: minmax(0, 1fr) auto; }
  .bar-name { grid-column: 1 / -1; padding-top: 0.5rem; }
  .bar-axis > span:first-child { display: none; }
  .recall { padding-left: 2.25rem; }
}
@media (prefers-reduced-motion: no-preference) {
  .hair, .bar-row, .f-track { transition: opacity 120ms ease, background-color 120ms ease; }
}
/* The tooltip hides with its hidden attribute; display: grid above would show it. */
.tip[hidden] { display: none; }
/* Model names are long and unbreakable (org/name-variant); they wrap at any character. */
h1, h2, .lede, .bar-name, .legend li, .f-name, .heat-q, .heat-col span, .scores th { overflow-wrap: anywhere; }
/* Split switch: one button for each split; the chosen split's sections show. */
.splits { display: flex; flex-wrap: wrap; gap: 0.375rem; margin: 0 0 1.5rem; }
.splits button { font: 500 0.8125rem/1 var(--mono); color: var(--ink-2); background: var(--raised); border: 1px solid var(--ring); border-radius: 999px; padding: 0.5rem 0.875rem; cursor: pointer; }
.splits button[aria-pressed="true"] { color: var(--page); background: var(--ink); border-color: var(--ink); }
.splits button:focus-visible { outline: 2px solid var(--best); outline-offset: 2px; }
.split[hidden] { display: none; }
`;
