// Crawl the full news output of AI and tech news sources with elt's web source.
// Usage (cwd = fresh-7/siliconangle, so the source has its own HTTP cache and tables):
//   node ../crawl.ts siliconangle
// Seventh fresh stream, 2024-07..09 (relevance-profiles, round 16, #3523). Only
// SiliconANGLE is crawled: the Decoder's posts of the period are already in
// fresh-6/decoder/articles.sqlite (fresh-6 read every post of Decoder sitemaps
// 1 and 3..8, which hold every post modified from 2024-03-15), and prepare.ts
// reads them there. SiliconANGLE starts with no cache (fresh-6's held only
// 2024-10..12). Polite defaults of the crawler: one request in flight at a time, robots.txt
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
  // Post sitemaps by modified time (sitemap index, read 2026-11-01): 68 ends
  // at 2024-06-26, 69 at 2024-09-16, 70 at 2024-11-26, and 80 is the last; a
  // post published 2024-07..09 is modified then or later, so it is in 69..80.
  // The unnumbered post-sitemap.xml has a 2026 lastmod but holds only 2009-2010
  // posts (1,000 URLs, read 2026-11-01), so it is not read. The URL carries the
  // date, so only articles of 2024-07..09 are downloaded.
  siliconangle: {
    inputs: [69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80].map((n) => `https://siliconangle.com/post-sitemap${n}.xml`),
    include: [new URLPattern({ protocol: 'https', hostname: 'siliconangle.com', pathname: '/2024/(07|08|09)/*' })],
  },
  // The UTC start edge (cwd = fresh-7/edge): the URL date is the site's US
  // date and the period is UTC, so a post of the US evening of 2024-06-30 is
  // published on 2024-07-01 UTC (one: 01:44 UTC, found with the WordPress API
  // after the siliconangle run). A rerun of that run with a wider include
  // fetched nothing (its checkpoint has every sitemap as read), so these posts
  // have their own store; prepare.ts reads it as siliconangle and keeps the
  // UTC period.
  edge: {
    inputs: [69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80].map((n) => `https://siliconangle.com/post-sitemap${n}.xml`),
    include: [new URLPattern({ protocol: 'https', hostname: 'siliconangle.com', pathname: '/2024/06/30/*' })],
  },
  // Extraction parity, not part of fresh-7 (cwd = fresh-7/parity): elt
  // 4d63590f (#3505) changed the article extraction since fresh-6's crawl
  // (2026-10-30), and fresh-6 is round 16's teaching pool. These are the 62
  // SiliconANGLE articles of 2024-10-01..03 that fresh-6 holds; run it before
  // or after the siliconangle crawl, never beside it (one origin), then
  // compare-siliconangle.ts.
  parity: {
    inputs: ['https://siliconangle.com/post-sitemap70.xml'],
    include: [new URLPattern({ protocol: 'https', hostname: 'siliconangle.com', pathname: '/2024/10/(01|02|03)/*' })],
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
  // 12 hours, fresh-6's cap: about 12 sitemaps and 1,200 articles need far
  // less, and a run that stops resumes from its checkpoint.
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
