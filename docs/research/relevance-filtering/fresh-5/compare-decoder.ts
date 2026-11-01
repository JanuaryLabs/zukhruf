// Checks that today's elt dist extracts Decoder pages as fresh-4's did: for
// every URL in both crawls, title, textContent, publishedTime and list must
// match. Usage (cwd = fresh-5): node compare-decoder.ts
// Writes compare-decoder.json.
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

type Row = { articleUrl: string; title: string | null; textContent: string; publishedTime: string | null; list: number | null };
const read = (path: string) =>
  new Map(
    (new DatabaseSync(path, { readOnly: true }).prepare('select articleUrl, title, textContent, publishedTime, list from decoder').all() as Row[]).map((r) => [
      r.articleUrl,
      r,
    ]),
  );
const before = read('../fresh-4/decoder/articles.sqlite');
const now = read('decoder/articles.sqlite');
const fields = ['title', 'textContent', 'publishedTime', 'list'] as const;
const differing: { url: string; fields: string[] }[] = [];
let shared = 0;
for (const [url, row] of now) {
  const old = before.get(url);
  if (old === undefined) continue;
  shared++;
  const changed = fields.filter((f) => row[f] !== old[f]);
  if (changed.length > 0) differing.push({ url, fields: changed });
}
const result = { fresh4: before.size, fresh5: now.size, shared, identical: shared - differing.length, differing };
writeFileSync('compare-decoder.json', `${JSON.stringify(result, null, 1)}\n`);
console.log(JSON.stringify({ ...result, differing: differing.slice(0, 10) }));
