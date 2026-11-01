// Crawl the full news output of AI and tech news sources with elt's web source.
// Usage (cwd = fresh-5/<name>, so each source has its own HTTP cache and tables):
//   node ../crawl.ts <decoder|siliconangle>
// Sixth fresh stream, 2024-10..12 (relevance-profiles, round 15, #3421). The
// Decoder cache is a copy of fresh-5/decoder/.cache, so cached pages are
// revalidated; SiliconANGLE starts with no cache (fresh-5's held only 2025).
// Polite defaults of the crawler: one request in flight at a time, robots.txt
// and its Crawl-delay for its user agent, and a slowdown after a 429 or 5xx. On top of the crawler's own breaker, this script stops
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
  // Yoast post sitemaps, ordered by modified time (read 2026-10-30): 2 runs
  // 2023-07-29..2024-03-15, so it holds no post published 2024-10..12; 3 runs
  // 2024-03-15..2024-11-02 (142 entries modified 2024-10..12); 4 runs
  // 2024-11-02..2025-06-22; 5..8 hold posts modified later. Sitemap 1 (no
  // number) spans lastmods 2021-12-25..2026-10-30, so it can hold a post of
  // the period edited since; it is read too. The URLs carry no date, so every
  // post of 1 and 3..8 is read and prepare.ts keeps the period.
  decoder: {
    inputs: ['', 3, 4, 5, 6, 7, 8].map((n) => `https://the-decoder.com/post-sitemap${n}.xml`),
    include: [new URLPattern('https://the-decoder.com/*')],
  },
  // Post sitemaps by modified time (sitemap index, 2026-10-30): 69 ends at
  // 2024-09-16, 70 at 2024-11-26, 71 at 2025-02-27; a post published
  // 2024-10..12 is modified then or later, so it is in 70..80. The URL carries
  // the date, so only articles of 2024-10..12 are downloaded.
  siliconangle: {
    inputs: [70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80].map((n) => `https://siliconangle.com/post-sitemap${n}.xml`),
    include: [new URLPattern({ protocol: 'https', hostname: 'siliconangle.com', pathname: '/2024/(10|11|12)/*' })],
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

// elt 79237704 (#3404): a web source takes many web streams, each with its
// own inputs.
const source = new WebSource({
  streams: [
    {
      stream: new WebStream({
        name: 'articles',
        primaryKey: ['articleUrl'],
        readers: [new ListingReader()],
        include: config.include,
        extractor: new ArticleExtractor(),
      }),
      inputs: config.inputs,
    },
  ],
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
          // Resumable (2026-10-31, round 15): full_refresh/overwrite committed
          // nothing when any page failed, and Decoder runs 1-6 lost every page
          // to a full disk, ENETUNREACH while the Mac slept, or a stop. Each
          // page now commits with the crawl's checkpoint, and a rerun starts
          // from that frontier and fetches only what is missing or failed.
          // The article set is the same: prepare.ts keeps the period.
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        }),
      ],
    }),
  ],
});

const started = Date.now();
try {
  // 12 hours: the Decoder answers few revalidations with 304, so each run
  // fetches most of its ~8,200 pages again at ~0.5 a second (~4.5 hours);
  // run 3 stopped at the old 4-hour cap with ~7,960 of them (2026-10-31).
  await pipeline.run({ signal: AbortSignal.any([stop.signal, AbortSignal.timeout(43_200_000)]) });
  console.log(`${name}: done in ${Math.round((Date.now() - started) / 1000)} s`, Object.fromEntries(statuses));
} catch (error) {
  console.error(`${name}: failed after ${Math.round((Date.now() - started) / 1000)} s`, Object.fromEntries(statuses));
  console.error(error);
  for (const e of (error as { errors?: unknown[] }).errors ?? []) console.error(' -', e);
  process.exitCode = 1;
} finally {
  clearInterval(progress);
}
