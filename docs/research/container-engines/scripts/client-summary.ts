// Writes summary.tsv for the client-level experiments (2, postgres-time-to-ready, and 7,
// attach-round-trip) from the slot files that their scripts wrote in one run folder.
//
// Usage: node --conditions=@zukhruf/source client-summary.ts --dir <run folder> [--dry-run]
//
// A slot file is <slot>.json with { engine, first, runs }; each run has `metrics`, a map from a
// metric name to a number, to an array of numbers (pooled, such as the 20 round trips of one
// container), or to null (not measured, such as the container-IP path on Docker Desktop). The
// slot's first run is summarized apart (sample "first") from the others (sample "warm").
// Quantiles are NumPy's default, linear, through @zukhruf/statistics.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { Linear } from '@zukhruf/statistics';

import { engineId } from './engine-id.ts';

type Metric = number | number[] | null;

interface Run {
  metrics: Record<string, Metric>;
  error?: string;
}

interface SlotFile {
  engine: string;
  first: Run | null;
  runs: Run[];
}

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const dir = values.dir;
if (!dir) throw new Error('--dir is required');
const out = join(dir, 'summary.tsv');

if (values['dry-run']) {
  console.log(
    `would read ${dir}/[0-9][0-9]-<engine>.json and write ${out}: engine, metric, sample (first|warm), n, failed, median, p95, min, max (ms)`,
  );
  process.exit(0);
}

const slotFiles = readdirSync(dir)
  .filter((name) =>
    new RegExp(String.raw`^\d{2}-${engineId}\.json$`).test(name),
  )
  .sort();
if (slotFiles.length === 0) throw new Error(`no slot files in ${dir}`);

// engine -> sample -> metric -> values; failed runs counted per engine and sample.
const pooled = new Map<string, Map<string, Map<string, number[]>>>();
const failed = new Map<string, number>();

function add(engine: string, sample: string, run: Run): void {
  if (run.error !== undefined) {
    const key = `${engine}\t${sample}`;
    failed.set(key, (failed.get(key) ?? 0) + 1);
  }
  const bySample = pooled.get(engine) ?? new Map();
  pooled.set(engine, bySample);
  const byMetric: Map<string, number[]> = bySample.get(sample) ?? new Map();
  bySample.set(sample, byMetric);
  for (const [name, metric] of Object.entries(run.metrics)) {
    if (metric === null) continue;
    const list = byMetric.get(name) ?? [];
    byMetric.set(name, list);
    list.push(...(Array.isArray(metric) ? metric : [metric]));
  }
}

for (const name of slotFiles) {
  const slot: SlotFile = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  if (slot.first) add(slot.engine, 'first', slot.first);
  for (const run of slot.runs) add(slot.engine, 'warm', run);
}

const quantile = new Linear();
const round = (value: number) => value.toFixed(1);
const rows = [
  [
    'engine',
    'metric',
    'sample',
    'n',
    'failed',
    'median',
    'p95',
    'min',
    'max',
  ].join('\t'),
];
for (const [engine, bySample] of [...pooled].sort()) {
  for (const sample of ['first', 'warm']) {
    const byMetric = bySample.get(sample);
    if (!byMetric) continue;
    for (const [metric, list] of byMetric) {
      if (list.length === 0) continue;
      const sorted = list.toSorted((a, b) => a - b);
      rows.push(
        [
          engine,
          metric,
          sample,
          String(sorted.length),
          String(failed.get(`${engine}\t${sample}`) ?? 0),
          round(quantile.of(sorted, 0.5)),
          round(quantile.of(sorted, 0.95)),
          round(sorted[0]!),
          round(sorted.at(-1)!),
        ].join('\t'),
      );
    }
  }
}
writeFileSync(out, `${rows.join('\n')}\n`);
console.log(`summary: ${out}`);
