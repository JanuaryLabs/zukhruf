import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type AnswerRow,
  type EvalSet,
  type Text,
  textHash,
} from '../answer-key.ts';

export const CACHE_FOLDER = join(import.meta.dirname, '../cache');

// A text in the local cache, with the hash of its content.
export type CachedText = Text & {
  readonly sha256: string;
  // How the text came into the cache: the URL it was fetched or rebuilt
  // from, or the file it was seeded from.
  readonly from: string;
  readonly at: string;
};

// A row whose text the source did not give.
export type Missing = { readonly missing: string };

export type TextReport = {
  readonly texts: ReadonlyMap<string, Text>;
  // The rows with no text. The runner scores the set without them, and
  // says so.
  readonly vanished: readonly {
    readonly id: string;
    readonly reason: string;
  }[];
  // The rows whose text is not the text of the answer key.
  readonly changed: readonly {
    readonly id: string;
    readonly expected: string;
    readonly actual: string;
  }[];
};

// Gets the texts of a set. The cache holds one text for each row, so a run
// downloads nothing when the cache is full. refresh: get each text from its
// source again.
export abstract class TextSource {
  async texts(set: EvalSet, refresh: boolean): Promise<TextReport> {
    const file = join(CACHE_FOLDER, 'texts', `${set.name}.json`);
    const cache: Record<string, CachedText> = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8'))
      : {};
    const wanted = refresh
      ? set.rows
      : set.rows.filter((row) => cache[row.id] === undefined);
    const vanished: { id: string; reason: string }[] = [];
    if (wanted.length > 0) {
      const at = new Date().toISOString();
      for (const [id, result] of await this.fetch(wanted))
        if ('missing' in result) vanished.push({ id, reason: result.missing });
        else
          cache[id] = {
            title: result.text.title,
            body: result.text.body,
            sha256: textHash(result.text),
            from: result.from,
            at,
          };
      mkdirSync(join(CACHE_FOLDER, 'texts'), { recursive: true });
      writeFileSync(file, JSON.stringify(cache));
    }
    const missing = new Set(vanished.map(({ id }) => id));
    const texts = new Map<string, Text>();
    const changed: TextReport['changed'][number][] = [];
    for (const row of set.rows) {
      if (missing.has(row.id)) continue;
      const cached = cache[row.id];
      if (cached === undefined) {
        vanished.push({ id: row.id, reason: 'The source gave no text.' });
        continue;
      }
      texts.set(row.id, { title: cached.title, body: cached.body });
      if (cached.sha256 !== row.textSha256)
        changed.push({
          id: row.id,
          expected: row.textSha256,
          actual: cached.sha256,
        });
    }
    return { texts, vanished, changed };
  }

  // The text of each row, or why there is none. from names where the text
  // came from.
  protected abstract fetch(
    rows: readonly AnswerRow[],
  ): Promise<
    Map<string, { readonly text: Text; readonly from: string } | Missing>
  >;
}
