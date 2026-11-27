// The CSS of the HTML page: one 64rem column, a claim above the primitives of
// each section, light and dark themes. A copy of the shell of mteb's page
// (packages/mteb/src/report/styles.ts, docs/copied-code.md); the series
// colours are the eight slots of the dataviz palette, light and dark, in its
// fixed order (validated on #ffffff and #101318).

const dark = `
  --page: #101318; --raised: #171b21; --ink: #eef1f4; --ink-2: #b6bdc7; --muted: #8b93a0;
  --grid: #242931; --axis: #3a414b; --other: #4a515c;
  --good-ink: #0ca30c; --bad-ink: #e66767; --wash: rgba(255, 255, 255, 0.05); --ring: rgba(255, 255, 255, 0.12);
  --heat-lo: #18212d; --heat-hi: #86b6ef; --shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  --s0: #338ced; --s1: #e76624; --s2: #00a888; --s3: #d28e05; --s4: #e24d8b; --s5: #0aac23; --s6: #9887ef; --s7: #eb6263;
  color-scheme: dark;
`;

export const styles = `
:root {
  --page: #ffffff;
  --raised: #f4f6f9;
  --ink: #10151c;
  --ink-2: #4a5361;
  --muted: #6c7481;
  --grid: #e6e9ee;
  --axis: #c3c9d2;
  --other: #c9ced6;
  --good-ink: #006300;
  --bad-ink: #b3261e;
  --wash: rgba(16, 21, 28, 0.05);
  --ring: rgba(16, 21, 28, 0.12);
  --heat-lo: #eef3fa;
  --heat-hi: #104281;
  --shadow: 0 8px 24px rgba(16, 21, 28, 0.14);
  --s0: #257de0; --s1: #f47230; --s2: #00b894; --s3: #f2a600; --s4: #ee7fac; --s5: #008a17; --s6: #6a4ce2; --s7: #ec4647;
  --sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${dark}}
}
:root[data-theme="dark"] {${dark}}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 400 1rem/1.55 var(--sans); }
table { font: inherit; color: inherit; border-collapse: collapse; }
p, h1, h2, ul, figure { margin: 0; }
ul { padding: 0; list-style: none; }
:focus-visible { outline: 2px solid var(--s0); outline-offset: 2px; }
[data-series="0"] { --c: var(--s0); } [data-series="1"] { --c: var(--s1); } [data-series="2"] { --c: var(--s2); } [data-series="3"] { --c: var(--s3); }
[data-series="4"] { --c: var(--s4); } [data-series="5"] { --c: var(--s5); } [data-series="6"] { --c: var(--s6); } [data-series="7"] { --c: var(--s7); }
[data-series="other"] { --c: var(--other); }
[data-tone="good"] { color: var(--good-ink); }
[data-tone="bad"] { color: var(--bad-ink); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.icon { font-family: var(--sans); margin-right: 0.25rem; }

.page {
  max-width: 64rem; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr); gap: 4rem;
  padding-block: 3.5rem 3rem;
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
}
h1 { font-size: clamp(2rem, 5vw, 3.25rem); line-height: 1.06; font-weight: 600; letter-spacing: -0.025em; text-wrap: balance; max-width: 24ch; }
.section { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1.5rem; border-top: 1px solid var(--grid); padding-top: 2.25rem; }
h2 { font-size: clamp(1.25rem, 2.6vw, 1.625rem); line-height: 1.25; font-weight: 600; letter-spacing: -0.015em; text-wrap: balance; max-width: 44rem; }
.note { color: var(--ink-2); max-width: 44rem; }
.chart { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.75rem; }
.legend { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; font-size: 0.8125rem; color: var(--ink-2); }
.legend li { display: inline-flex; align-items: center; gap: 0.5rem; }
.legend li::before { content: ""; width: 1rem; height: 2px; border-radius: 1px; background: var(--c); }

.bars { display: grid; grid-template-columns: minmax(7rem, 14rem) minmax(0, 1fr) minmax(9rem, auto); }
.bar-row, .bar-axis { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: center; }
.bar-row { border-radius: 4px; cursor: default; }
.bar-row:hover, .bar-row:focus-visible { background: var(--wash); }
.bar-name { font-size: 0.875rem; padding: 0 0.75rem 0 0.25rem; }
.bar-track {
  position: relative; height: 2.5rem;
  background-image: linear-gradient(to right, var(--grid) 1px, transparent 1px); background-size: 25% 100%;
  border-right: 1px solid var(--grid);
}
.bar { position: absolute; left: 0; top: 50%; translate: 0 -50%; height: 1.25rem; width: var(--x); background: var(--s0); border-radius: 0 4px 4px 0; }
.whisker { position: absolute; top: 50%; left: var(--a); width: calc(var(--b) - var(--a)); height: 0; border-top: 1.5px solid var(--ink); }
.whisker::before, .whisker::after { content: ""; position: absolute; top: -0.4375rem; height: 0.75rem; width: 1.5px; background: var(--ink); }
.whisker::before { left: 0; }
.whisker::after { right: 0; }
.bar-ref { position: absolute; top: 0; bottom: 0; left: var(--x); width: 1.5px; translate: -50% 0; background: var(--ink-2); }
.bar-value { padding-left: 0.75rem; font: 500 0.8125rem var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.bar-value small { font-size: 0.75rem; color: var(--muted); font-weight: 400; }
.bar-ticks, .x-ticks, .ref-labels { position: relative; height: 1.5rem; font: 0.75rem var(--mono); color: var(--muted); }
.bar-ticks span, .x-ticks span, .ref-labels span { position: absolute; left: var(--x); translate: -50% 0; top: 0.25rem; white-space: nowrap; }
.ref-labels span { color: var(--ink-2); font-weight: 500; translate: calc(var(--x) * -1) 0; }
.x-ticks span:first-child { translate: 0 0; }
.x-ticks span:last-child:not(:first-child) { translate: -100% 0; }

.frame { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.25rem; padding-left: 2.75rem; }
.plot { position: relative; height: 16rem; margin: 0.75rem 0.75rem 0 0.75rem; }
.plot.square { height: auto; aspect-ratio: 1; }
.frame.square { max-width: 30rem; }
.plot svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.gridline { position: absolute; left: -0.75rem; right: -0.75rem; top: var(--y); height: 1px; background: var(--grid); }
.gridline span { position: absolute; right: calc(100% + 0.5rem); top: 0; translate: 0 -50%; font: 0.75rem var(--mono); color: var(--muted); }
.vline { position: absolute; top: -0.75rem; bottom: -0.75rem; left: var(--x); width: 1px; background: var(--grid); }
.diagonal { stroke: var(--axis); stroke-width: 1.5; }
.diagonal-label { position: absolute; left: 1.5rem; bottom: 0.25rem; font: 0.75rem var(--mono); color: var(--muted); }
.axis-title { font-size: 0.75rem; color: var(--ink-2); }
.axis-title.x { text-align: right; margin-inline: 0.75rem; }
.line { fill: none; stroke: var(--c); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.ends-band { fill: var(--c); opacity: 0.12; }
.dot { position: absolute; left: var(--x); top: var(--y); width: 8px; height: 8px; translate: -50% -50%; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 2px var(--page); pointer-events: none; }
.point { position: absolute; left: var(--x); top: var(--y); width: 24px; height: 24px; translate: -50% -50%; border-radius: 50%; cursor: default; }
.point::before { content: ""; position: absolute; inset: 8px; border-radius: 50%; background: var(--s0); box-shadow: 0 0 0 2px var(--page); }
.point:hover::before, .point:focus-visible::before { background: var(--ink); }
.step { position: absolute; top: 0; bottom: 0; left: var(--a); width: calc(var(--b) - var(--a)); }
.hair { position: absolute; top: 0; bottom: 0; left: var(--h); width: 1px; background: var(--ink-2); opacity: 0; }
.step:hover .hair, .step:focus-visible .hair { opacity: 0.6; }
.step:focus-visible { outline-offset: -2px; }
.x-ticks { margin-inline: 0.75rem; }

.heat-scroll, .table-scroll { overflow-x: auto; }
.heat-scroll, .table-scroll { position: relative; }
.heat { display: grid; grid-template-columns: minmax(10rem, 2fr) repeat(var(--cols), minmax(3rem, 1fr)); gap: 2px; min-width: calc(10rem + var(--cols) * 3.25rem); }
.heat-row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; }
.heat-col { font-size: 0.75rem; line-height: 1.2; color: var(--ink-2); text-align: center; align-self: end; padding-bottom: 0.375rem; }
.heat-name { font: 0.75rem/1.35 var(--mono); color: var(--ink-2); padding: 0.375rem 0.75rem 0.375rem 0; align-self: center; }
.heat-cell { min-height: 2rem; border-radius: 2px; background: color-mix(in oklab, var(--heat-hi) calc(var(--v) * 100%), var(--heat-lo)); }
.heat-cell[data-missing] { background: var(--page); outline: 1px dashed var(--axis); outline-offset: -1px; }
.heat-cell:hover, .heat-cell:focus-visible { outline: 2px solid var(--ink); outline-offset: -2px; }
.scale { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; font: 0.75rem var(--mono); color: var(--muted); }
.scale-bar { width: 8rem; height: 0.5rem; border-radius: 2px; background: linear-gradient(in oklab to right, var(--heat-lo), var(--heat-hi)); outline: 1px solid var(--ring); outline-offset: -1px; }

.table-view summary { cursor: pointer; font-size: 0.8125rem; color: var(--ink-2); width: fit-content; }
.table-view[open] summary { margin-bottom: 0.75rem; }
table { width: 100%; font-size: 0.8125rem; }
th, td { text-align: right; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--grid); white-space: nowrap; font-variant-numeric: tabular-nums; }
th:first-child, td:first-child { text-align: left; white-space: normal; min-width: 10rem; }
tbody th { font-weight: 400; }
thead th { font-size: 0.75rem; font-weight: 500; color: var(--ink-2); background: var(--raised); }
.pairs-title { font-weight: 600; font-size: 0.9375rem; }
.pairs td, .pairs th { text-align: left; white-space: normal; vertical-align: top; }
.pairs code { font: 0.75rem var(--mono); }
.pairs td.mark { white-space: nowrap; font-weight: 500; }
.pairs [data-mark="agree"] .mark { color: var(--good-ink); }
.pairs [data-mark="near"] .mark { color: var(--ink-2); }
.pairs [data-mark="disagree"] .mark, .pairs [data-mark="only-expected"] .mark, .pairs [data-mark="only-actual"] .mark { color: var(--bad-ink); }

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
  .frame { padding-left: 2.25rem; }
}
@media (prefers-reduced-motion: no-preference) {
  .hair, .bar-row { transition: opacity 120ms ease, background-color 120ms ease; }
}
/* The tooltip hides with its hidden attribute; display: grid above would show it. */
.tip[hidden] { display: none; }
/* Labels come from pages and answers; long ones wrap at any character. */
h1, h2, .note, .bar-name, .legend li, .heat-name, .heat-col, th, td, .pairs-title { overflow-wrap: anywhere; }
`;
