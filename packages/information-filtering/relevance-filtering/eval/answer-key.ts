import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Role } from './roles.ts';

// The label of an article for a profile: true is relevant, null is
// ambiguous (the annotator gave an alternative), and no label is not
// relevant.
export type Label = true | null;

// One article of a set. The answer key holds no publisher text: the texts
// and the vectors are in the cache (README.md, "Cache").
export type Article = {
  readonly q: number;
  readonly id: string;
  readonly publishedAt: Date;
};

export type SetMetadata = {
  readonly role: Role;
  // When the labels were frozen, before any design was scored on them.
  readonly frozenAt: string;
  // When a design was first scored on the set. Null for an exam set that
  // was never scored.
  readonly firstScoredAt: string | null;
  // The sha256 of the bytes of each label file. The files are copies of the
  // frozen research files, so the hashes are the hashes of the research.
  readonly labelsSha256: Readonly<Record<string, string>>;
  readonly annotator: string;
  // The first publish day of a slice of the reader's feed. The first 14 days
  // are its teaching window (round 6).
  readonly sliceStart?: string;
  readonly source: string;
  readonly weaknesses: readonly string[];
};

export type EvalSet = {
  readonly name: string;
  readonly metadata: SetMetadata;
  // The articles in the order of their queue numbers (q).
  readonly articles: readonly Article[];
  // The labels of each article, in the order of the articles.
  readonly labels: readonly Readonly<Record<string, Label>>[];
};

export const EVAL_FOLDER = import.meta.dirname;
export const SETS_FOLDER = join(EVAL_FOLDER, 'sets');

export function setNames(): string[] {
  return readdirSync(SETS_FOLDER).toSorted();
}

// The set.json of a set. The runner reads it first, so it does not open the
// labels of an exam set that it does not score.
export function readMetadata(name: string): SetMetadata {
  return JSON.parse(readFileSync(join(SETS_FOLDER, name, 'set.json'), 'utf8'));
}

export function readArticles(name: string): Article[] {
  const rows: { q: number; id: string; publishedAt: string }[] = JSON.parse(
    readFileSync(join(SETS_FOLDER, name, 'articles.json'), 'utf8'),
  );
  return rows.map((row) => ({
    ...row,
    publishedAt: new Date(row.publishedAt),
  }));
}

export function readSet(name: string): EvalSet {
  const metadata = readMetadata(name);
  const files = Object.fromEntries(
    Object.entries(metadata.labelsSha256).map(([file, expected]) => {
      const bytes = readFileSync(join(SETS_FOLDER, name, file));
      const actual = sha256(bytes);
      if (actual !== expected)
        throw new Error(
          `The labels ${name}/${file} changed (sha256 ${actual}, set.json says ${expected}). Write the new sha256 into set.json, and give the reason for the label change in the commit.`,
        );
      return [file, bytes.toString('utf8')];
    }),
  );
  const articles = readArticles(name);
  const byQ = new Map<number, Record<string, Label>>(
    articles.map(({ q }) => [q, {}]),
  );
  for (const [file, text] of Object.entries(files)) {
    if (file === 'biology-labels.json') {
      const ids = new Map(articles.map(({ q, id }) => [id, q]));
      const rows: { id: string; relevant: boolean | null }[] = JSON.parse(text);
      for (const row of rows)
        if (row.relevant !== false)
          labelsOf(byQ, ids.get(row.id), file).biology = row.relevant;
      continue;
    }
    const rows: { q: number | string; labels: Record<string, Label> }[] =
      file.endsWith('.jsonl')
        ? text
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => JSON.parse(line))
        : JSON.parse(text);
    for (const row of rows)
      Object.assign(labelsOf(byQ, Number(row.q), file), row.labels);
  }
  return {
    name,
    metadata,
    articles,
    labels: articles.map(({ q }) => byQ.get(q) ?? {}),
  };
}

function labelsOf(
  byQ: Map<number, Record<string, Label>>,
  q: number | undefined,
  file: string,
): Record<string, Label> {
  const labels = q === undefined ? undefined : byQ.get(q);
  if (labels === undefined)
    throw new Error(
      `${file} labels an article that articles.json does not hold.`,
    );
  return labels;
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
