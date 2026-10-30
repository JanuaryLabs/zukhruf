import { setTimeout } from 'node:timers/promises';

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

import type { AnswerRow, Text } from '../answer-key.ts';
import { USER_AGENT } from './pinned-file.ts';
import { type Missing, TextSource } from './text-source.ts';

// One request to a host at most each second.
const PAUSE_MS = 1000;

// Web pages. Each row source is the URL of a report. The fetch is polite: it
// reads robots.txt first, sends one request at a time with a pause, names
// itself in the user agent, and stops asking a host that answers 429 or 403.
// The text is what Readability extracts. The answer keys of the web sets
// were made with elt's article extraction, so a text fetched here can differ
// from the text of the answer key even when the page is the same; the run
// reports such a text as changed.
export class WebPages extends TextSource {
  protected async fetch(
    rows: readonly AnswerRow[],
  ): Promise<Map<string, { text: Text; from: string } | Missing>> {
    const results = new Map<string, { text: Text; from: string } | Missing>();
    const byHost = Map.groupBy(rows, (row) => new URL(row.source).host);
    for (const [host, hostRows] of byHost) {
      const rules = await robots(new URL(hostRows[0]?.source ?? '').origin);
      let blocked: string | null = null;
      for (const row of hostRows) {
        if (blocked !== null) {
          results.set(row.id, { missing: blocked });
          continue;
        }
        if (!allowed(rules, new URL(row.source).pathname)) {
          results.set(row.id, {
            missing: `robots.txt of ${host} disallows it`,
          });
          continue;
        }
        const result = await reportText(row.source);
        if ('stop' in result) {
          blocked = result.stop;
          results.set(row.id, { missing: result.stop });
        } else results.set(row.id, result);
        await setTimeout(PAUSE_MS);
      }
    }
    return results;
  }
}

async function reportText(
  url: string,
): Promise<{ text: Text; from: string } | Missing | { stop: string }> {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429 || response.status === 403)
      return { stop: `HTTP ${response.status}: the host is no longer asked` };
    if (!response.ok) return { missing: `HTTP ${response.status}` };
    const { document } = parseHTML(await response.text());
    const parsed = new Readability(document).parse();
    const body = parsed?.textContent?.trim();
    if (!body) return { missing: 'No report text on the page' };
    return { text: { title: parsed?.title ?? '', body }, from: response.url };
  } catch (error) {
    return { missing: String(error) };
  }
}

type Rules = readonly { readonly allow: boolean; readonly path: string }[];

// The Allow and Disallow lines of the group for all user agents.
async function robots(origin: string): Promise<Rules> {
  const response = await fetch(`${origin}/robots.txt`, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (response === null || !response.ok) return [];
  const rules: { allow: boolean; path: string }[] = [];
  let inGroup = false;
  let groupHasRules = false;
  for (const raw of (await response.text()).split('\n')) {
    const [field = '', ...rest] = raw.replace(/#.*/u, '').split(':');
    const key = field.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      if (groupHasRules) inGroup = false;
      groupHasRules = false;
      inGroup ||= value === '*';
    } else if (key === 'allow' || key === 'disallow') {
      groupHasRules = true;
      if (inGroup && value) rules.push({ allow: key === 'allow', path: value });
    }
  }
  return rules;
}

// RFC 9309: the longest matching rule decides, Allow wins a tie, and no
// matching rule allows. "*" matches any characters, and a final "$" ends the
// path.
function allowed(rules: Rules, path: string): boolean {
  const matching = rules
    .filter((rule) =>
      new RegExp(
        `^${rule.path
          .replace(/[.+?^${}()|[\]\\]/gu, '\\$&')
          .replace(/\*/gu, '.*')
          .replace(/\\\$$/u, '$')}`,
        'u',
      ).test(path),
    )
    .toSorted(
      (a, b) =>
        b.path.length - a.path.length || Number(b.allow) - Number(a.allow),
    );
  return matching[0]?.allow ?? true;
}
