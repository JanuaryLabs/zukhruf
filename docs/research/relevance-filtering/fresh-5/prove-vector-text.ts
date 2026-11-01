// Proof that vector-text.ts gives the earlier stream's vector text: recompute
// it from title + body for every article of relevance-biology/stream/articles.json
// and compare bytes. Usage (cwd = fresh-5): node prove-vector-text.ts
import { readFileSync, writeFileSync } from 'node:fs';

import { vectorText } from './vector-text.ts';

const earlier = JSON.parse(
  readFileSync('/Users/ezzabuzaid/.codex/visualizations/2026/10/23/01a16a1c-424c-7793-8ca9-02cc1c715d82/relevance-biology/stream/articles.json', 'utf8'),
) as { id: string; title: string; body: string; vectorText: string; vectorFallback: boolean; lead: string; excerpt: string | null }[];
const differing = earlier.filter((a) => {
  const v = vectorText(a.title, a.body);
  return v.text !== a.vectorText || v.fallback !== a.vectorFallback || (v.lead || a.excerpt) !== a.lead;
});
const result = { checked: earlier.length, identical: earlier.length - differing.length, differing: differing.map((a) => a.id) };
writeFileSync('vector-text-proof.json', `${JSON.stringify(result, null, 1)}\n`);
console.log(JSON.stringify({ ...result, differing: result.differing.slice(0, 10) }));
if (differing.length > 0) process.exitCode = 1;
