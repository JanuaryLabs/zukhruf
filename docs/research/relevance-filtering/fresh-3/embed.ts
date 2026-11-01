// Embeds the third fresh stream with round-1's exact setup. Run: node embed.ts (cwd = fresh-3).
// Needs the b11836 server on :8098. Before any new text, checks the
// event-grouping probe vector and that re-embedded rows of the earlier streams
// (relevance-biology and the second fresh stream) give their stored vectors.
// Writes vectors.json and embed-report.json (the checks).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const biology = '/Users/ezzabuzaid/.codex/visualizations/2026/10/23/01a16a1c-424c-7793-8ca9-02cc1c715d82/relevance-biology';

const url = 'http://127.0.0.1:8098/v1/embeddings';
async function embed(texts: string[]): Promise<number[][]> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'embeddinggemma-2', input: texts }),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const body = (await response.json()) as { data: { index: number; embedding: number[] }[] };
  return body.data.sort((a, b) => a.index - b.index).map((row) => row.embedding);
}
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return dot / Math.sqrt(na * nb);
}

const probe = JSON.parse(readFileSync('/Users/ezzabuzaid/Desktop/experiments/mutex/packages/event-grouping/eval/probes/embeddinggemma-2.json', 'utf8')) as { text: string; vector: number[] };
const [probeVector] = await embed([probe.text]);
const probeCosine = cosine(probeVector!, probe.vector);
if (probeCosine < 0.9999) throw new Error(`probe cosine ${probeCosine}`);

type Article = { id: string; vectorText: string; vectorFallback: boolean };
const earlier = JSON.parse(readFileSync(`${biology}/stream/articles.json`, 'utf8')) as Article[];
const stored = new Map(
  (JSON.parse(readFileSync(`${biology}/pooled/vectors.json`, 'utf8')) as { rows: { id: string; vector: number[] }[] }).rows.map((r) => [r.id, r.vector]),
);
// Every 160th earlier article (24 of 3,838), embedded in batches of 16 as before.
const check = earlier.filter((_, i) => i % 160 === 0);
const again: number[][] = [];
for (let i = 0; i < check.length; i += 16) again.push(...(await embed(check.slice(i, i + 16).map((a) => a.vectorText))));
const cosines = check.map((a, i) => ({ id: a.id, cosine: cosine(stored.get(a.id)!, again[i]!) }));
const earlierAgreement = Math.min(...cosines.map((c) => c.cosine));
if (earlierAgreement < 0.9999) throw new Error(`earlier-stream agreement ${earlierAgreement}`);

// Every 72nd article of the second fresh stream (25 of 1,735), from its stored vector text.
const fresh = JSON.parse(readFileSync('../fresh-2/articles.json', 'utf8')) as Article[];
const freshStored = new Map(
  (JSON.parse(readFileSync('../fresh-2/vectors.json', 'utf8')) as { rows: { id: string; vector: number[] }[] }).rows.map((r) => [r.id, r.vector]),
);
const freshCheck = fresh.filter((_, i) => i % 72 === 0);
const freshAgain: number[][] = [];
for (let i = 0; i < freshCheck.length; i += 16) freshAgain.push(...(await embed(freshCheck.slice(i, i + 16).map((a) => a.vectorText))));
const freshCosines = freshCheck.map((a, i) => ({ id: a.id, cosine: cosine(freshStored.get(a.id)!, freshAgain[i]!) }));
const freshAgreement = Math.min(...freshCosines.map((c) => c.cosine));
if (freshAgreement < 0.9999) throw new Error(`fresh-stream agreement ${freshAgreement}`);

const articles = JSON.parse(readFileSync('articles.json', 'utf8')) as Article[];
const vectors: number[][] = [];
for (let i = 0; i < articles.length; i += 16) vectors.push(...(await embed(articles.slice(i, i + 16).map((a) => a.vectorText))));
const rows = articles.map((a, i) => ({
  id: a.id,
  textSha256: createHash('sha256').update(a.vectorText).digest('hex'),
  fallback: a.vectorFallback,
  vector: vectors[i],
}));
writeFileSync('vectors.json', JSON.stringify({ model: 'embeddinggemma-2-Q8_0 (llama.cpp b11836)', probeCosine, rows }));
const report = { probeCosine, earlierAgreement, earlierChecked: cosines, freshAgreement, freshChecked: freshCosines, rows: rows.length, fallbacks: rows.filter((r) => r.fallback).length };
writeFileSync('embed-report.json', `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify({ ...report, earlierChecked: cosines.length, freshChecked: freshCosines.length }));
