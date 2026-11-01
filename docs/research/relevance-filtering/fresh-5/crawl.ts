// Crawl the full news output of AI and tech news sources with elt's web source.
// Usage (cwd = fresh-5/<name>, so each source has its own HTTP cache and tables):
//   node ../crawl.ts <decoder|siliconangle>
// Fifth fresh stream, 2025-01..03 (relevance-profiles, #3195). Each cache is a
// copy of fresh-4/<name>/.cache, so cached pages are reused.
// Polite defaults of the crawler: two request starts per second, robots.txt
// for its user agent. On top of the crawler's own breaker, this script stops
// the whole crawl at the first 403 or 429 answer (rule of this round).
import { subscribe } from 'node:diagnostics_channel';

import { Connection, Copy, Pipeline } from '/Users/ezzabuzaid/Desktop/experiments/elt/packages/elt/dist/index.js';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '/Users/ezzabuzaid/Desktop/experiments/elt/packages/destinations/sqlite/dist/index.js';
import { ListingReader } from '/Users/ezzabuzaid/Desktop/experiments/elt/packages/sdks/web/crawler/dist/index.js';
import { ArticleExtractor } from '/Users/ezzabuzaid/Desktop/experiments/elt/packages/sources/web/pages/dist/article-extractor.js';
import { WebSource } from '/Users/ezzabuzaid/Desktop/experiments/elt/packages/sources/web/pages/dist/web-source.js';
import { WebStream } from '/Users/ezzabuzaid/Desktop/experiments/elt/packages/sources/web/pages/dist/web-stream.js';

const sources = {
  // Yoast post sitemaps, ordered by modified time (read 2026-10-30): 3 ends
  // at 2024-11-02, so it holds no post of 2025-01..03; 4 runs
  // 2024-11-02..2025-06-22; 5, 6, 7 and 8 hold posts modified later, which can
  // be posts of 2025-01..03 edited since. The URLs carry no date, so every post
  // of 4..8 is read and prepare.ts keeps the period.
  decoder: {
    inputs: [4, 5, 6, 7, 8].map((n) => `https://the-decoder.com/post-sitemap${n}.xml`),
    include: [new URLPattern('https://the-decoder.com/*')],
  },
  // Post sitemap 70 ends at posts modified 2024-12-10 and 71 starts at
  // 2024-11-26, so 71..80 hold every post of 2025-01..03 (2025-01..03 URLs on
  // 2026-10-30: 71: 588, 72: 418, 73: 2, 74: 2, 75: 2, 76: 0, 77: 2, 78..80: 0).
  // The URL carries the date, so only articles of 2025-01..03 are downloaded.
  siliconangle: {
    inputs: [71, 72, 73, 74, 75, 76, 77, 78, 79, 80].map((n) => `https://siliconangle.com/post-sitemap${n}.xml`),
    include: [new URLPattern({ protocol: 'https', hostname: 'siliconangle.com', pathname: '/2025/(01|02|03)/*' })],
  },
};

const name = process.argv[2] as keyof typeof sources;
const config = sources[name];
if (config === undefined) throw new Error(`Unknown source ${process.argv[2]}`);

const stop = new AbortController();
const statuses = new Map<number, number>();
subscribe('http.client.response.finish', (message) => {
  const { request, response } = message as { request: { host: string; path: string }; response: { statusCode: number } };
  statuses.set(response.statusCode, (statuses.get(response.statusCode) ?? 0) + 1);
  if (response.statusCode === 403 || response.statusCode === 429) {
    console.error(`STOP: ${response.statusCode} from https://${request.host}${request.path}`);
    stop.abort(new Error(`${response.statusCode} answer`));
  }
});
const progress = setInterval(() => console.log(new Date().toISOString(), Object.fromEntries(statuses)), 60_000);

const source = new WebSource({
  stream: new WebStream({
    name: 'articles',
    primaryKey: ['articleUrl'],
    readers: [new ListingReader()],
    include: config.include,
    extractor: new ArticleExtractor(),
  }),
  inputs: config.inputs,
  cachePath: './.cache/web-http.sqlite',
  // elt now requires the host to name the crawler (elt 7b3b9bf5, #3249). Both
  // robots.txt files (read 2026-10-29) have only a `*` group, which this token
  // obeys like Got's default agent that fresh-2 sent.
  userAgent: 'relevance-profiles-crawl/0.1 (+https://github.com/ezzabuzaid/elt)',
});
const destination = new SQLiteDestination({ path: './articles.sqlite' });
const pipeline = new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name,
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({ path: './articles-state.sqlite' }),
      steps: [
        new Copy((await source.discover()).get('articles'), destination.table(name), {
          id: `${name}:articles`,
          syncMode: 'full_refresh',
          destinationSyncMode: 'overwrite',
        }),
      ],
    }),
  ],
});

const started = Date.now();
try {
  await pipeline.run({ signal: AbortSignal.any([stop.signal, AbortSignal.timeout(14_400_000)]) });
  console.log(`${name}: done in ${Math.round((Date.now() - started) / 1000)} s`, Object.fromEntries(statuses));
} catch (error) {
  console.error(`${name}: failed after ${Math.round((Date.now() - started) / 1000)} s`, Object.fromEntries(statuses));
  console.error(error);
  for (const e of (error as { errors?: unknown[] }).errors ?? []) console.error(' -', e);
  process.exitCode = 1;
} finally {
  clearInterval(progress);
}
