// Checks that today's elt dist extracts SiliconANGLE pages as fresh-6's crawl
// did (fresh-6 is round 16's teaching pool): for every URL in both crawls,
// title, excerpt, textContent, publishedTime and list must match. Copied from
// fresh-6/compare-decoder.ts; the tables and the excerpt field differ.
// Usage (cwd = fresh-7, after node ../crawl.ts parity in parity/): node compare-siliconangle.ts
// Writes compare-siliconangle.json.
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

type Row = {
  articleUrl: string;
  title: string | null;
  excerpt: string | null;
  textContent: string;
  publishedTime: string | null;
  list: number | null;
};
const read = (path: string, table: string) =>
  new Map(
    (
      new DatabaseSync(path, { readOnly: true })
        .prepare(`select articleUrl, title, excerpt, textContent, publishedTime, list from ${table}`)
        .all() as Row[]
    ).map((r) => [r.articleUrl, r]),
  );
const before = read('../fresh-6/siliconangle/articles.sqlite', 'siliconangle');
const now = read('parity/articles.sqlite', 'parity');
const fields = ['title', 'excerpt', 'textContent', 'publishedTime', 'list'] as const;
const differing: { url: string; fields: string[]; textChars?: [number, number] }[] = [];
let shared = 0;
for (const [url, row] of now) {
  const old = before.get(url);
  if (old === undefined) continue;
  shared++;
  const changed = fields.filter((f) => row[f] !== old[f]);
  if (changed.length > 0)
    differing.push({
      url,
      fields: changed,
      ...(changed.includes('textContent') ? { textChars: [old.textContent.length, row.textContent.length] as [number, number] } : {}),
    });
}
const result = { fresh6: before.size, parity: now.size, shared, identical: shared - differing.length, differing };
writeFileSync('compare-siliconangle.json', `${JSON.stringify(result, null, 1)}\n`);
console.log(JSON.stringify({ ...result, differing: differing.slice(0, 10) }));
