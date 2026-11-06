// Turn the crawled tables into the seventh fresh stream (2024-07..09, round 16, #3523).
// Usage (cwd = this folder): node prepare.ts
// The Decoder table is fresh-6's crawl store (fresh-6 read every Decoder post
// modified from 2024-03-15); SiliconANGLE's is this folder's crawl.
// Writes articles.json (kept articles: title, lead, body, vector text) and
// prepare-report.json (dropped rows and why).
import { readFileSync, writeFileSync } from 'node:fs';
import { open } from '@zukhruf/sqlite-open';

import { vectorText } from './vector-text.ts';

const FROM = Date.parse('2024-07-01T00:00:00Z');
const TO = Date.parse('2024-10-01T00:00:00Z'); // through 2024-09-30
const PARTIAL_CHARS = 1500;

// URL identity for exclusion and duplicates: lower-cased host, no query, fragment or trailing slash.
// A URL with no path keeps its query (round 16): a WordPress shortlink such as
// https://the-decoder.com/?p=16743 is one post, and without its query every
// shortlink had the same key, so all but the first were skipped as duplicates
// (fresh-7 lost a 2024-08-21 Decoder post that has no other URL in the store).
const key = (url: string) => {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/u, '');
  return `${u.protocol}//${u.host.toLowerCase().replace(/^www\./u, '')}${path}${path === '' ? u.search : ''}`;
};
const visualizations = '/Users/ezzabuzaid/.codex/visualizations/2026/10/23/01a16a1c-424c-7793-8ca9-02cc1c715d82';
const exclusions = JSON.parse(readFileSync(`${visualizations}/relevance-biology/stream/exclusions.json`, 'utf8')) as Record<string, string[]>;
const excluded = new Map<string, string>();
for (const [set, urls] of Object.entries(exclusions)) for (const url of urls) excluded.set(key(url), set.split('(')[0]!);
// The articles already in this round, the collection and the first six fresh
// streams: their ids (source URLs) and their titles. Only these two fields are read.
const earlier = new Map<string, string>(); // title identity -> set
for (const [set, path] of [
  ['collection', 'collection/items.json'],
  ['fresh', 'fresh/articles.json'],
  ['fresh-2', 'fresh-2/articles.json'],
  ['fresh-3', 'fresh-3/articles.json'],
  ['fresh-4', 'fresh-4/articles.json'],
  ['fresh-5', 'fresh-5/articles.json'],
  ['fresh-6', 'fresh-6/articles.json'],
] as const) {
  const rows = (JSON.parse(readFileSync(`${visualizations}/relevance-profiles/${path}`, 'utf8')) as { id: string; title: string }[]).map(({ id, title }) => ({ id, title }));
  for (const { id } of rows) if (!excluded.has(key(id))) excluded.set(key(id), set);
  // Same title identity as the duplicate-title rule: trimmed, lower-cased.
  for (const { title } of rows) if (!earlier.has(title.trim().toLowerCase())) earlier.set(title.trim().toLowerCase(), set);
}

type Row = {
  articleUrl: string;
  title: string | null;
  publishedTime: string | null;
  excerpt: string | null;
  textContent: string;
  length: number;
  list: number | null;
};

const kept: { publishedAt: string; [k: string]: unknown }[] = [];
const dropped: { source: string; url: string; why: string }[] = [];
const seenUrls = new Set<string>();
const seenTitles = new Map<string, string>();
const candidates: (Row & { source: string; time: number })[] = [];

// [publisher, store, table]; edge holds SiliconANGLE's posts of the UTC start
// edge (crawl.ts 'edge').
const stores = [
  ['decoder', '../fresh-6/decoder/articles.sqlite', 'decoder'],
  ['siliconangle', 'siliconangle/articles.sqlite', 'siliconangle'],
  ['siliconangle', 'edge/articles.sqlite', 'edge'],
] as const;
for (const [source, store, table] of stores) {
  const db = open(store, { readOnly: true });
  const rows = db
    .prepare(`select articleUrl, title, publishedTime, excerpt, textContent, length, list from ${table} order by articleUrl`)
    .all() as Row[];
  for (const row of rows) {
    const k = key(row.articleUrl);
    if (seenUrls.has(k)) continue;
    seenUrls.add(k);
    const time = row.publishedTime ? Date.parse(row.publishedTime) : Number.NaN;
    if (Number.isNaN(time)) dropped.push({ source, url: row.articleUrl, why: `no date (${row.publishedTime})` });
    else if (time < FROM || time >= TO) dropped.push({ source, url: row.articleUrl, why: 'outside period' });
    else if (excluded.has(k)) dropped.push({ source, url: row.articleUrl, why: `excluded: ${excluded.get(k)}` });
    else if (row.list) dropped.push({ source, url: row.articleUrl, why: 'listing page' });
    else candidates.push({ ...row, source, time });
  }
}
candidates.sort((a, b) => a.time - b.time || a.articleUrl.localeCompare(b.articleUrl));
for (const row of candidates) {
  const title = (row.title ?? '').replace(/\s*[|–-]\s*(THE DECODER|SiliconANGLE)\s*$/iu, '').trim();
  const t = title.toLowerCase();
  if (earlier.has(t)) {
    dropped.push({ source: row.source, url: row.articleUrl, why: `excluded: ${earlier.get(t)} title` });
    continue;
  }
  if (seenTitles.has(t)) {
    dropped.push({ source: row.source, url: row.articleUrl, why: `duplicate title of ${seenTitles.get(t)}` });
    continue;
  }
  seenTitles.set(t, row.articleUrl);
  const v = vectorText(title, row.textContent);
  kept.push({
    id: row.articleUrl,
    source: row.articleUrl,
    publishedAt: new Date(row.time).toISOString(),
    publisher: row.source,
    title,
    lead: v.lead || row.excerpt,
    excerpt: row.excerpt,
    bodyChars: row.length,
    partial: row.length < PARTIAL_CHARS,
    vectorText: v.text,
    vectorFallback: v.fallback,
    body: row.textContent,
  });
}

writeFileSync('articles.json', `${JSON.stringify(kept, null, 1)}\n`);
writeFileSync('prepare-report.json', `${JSON.stringify(dropped, null, 1)}\n`);
console.log(
  'kept',
  kept.length,
  Object.fromEntries(Object.entries(Object.groupBy(kept, (a) => a.publisher as string)).map(([k, v]) => [k, v?.length])),
  'dropped',
  Object.fromEntries(
    Object.entries(Object.groupBy(dropped, (d) => `${d.source}: ${d.why.split(' (')[0]!.split(' of ')[0]}`)).map(([k, v]) => [k, v?.length]),
  ),
);
