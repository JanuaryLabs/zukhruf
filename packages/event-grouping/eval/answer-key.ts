import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Role } from './roles.ts';

// One labelled report of a set. The answer key holds no publisher text:
// the runner gets the text at run time from source.
export type AnswerRow = {
  readonly id: string;
  // Where the text comes from: the report URL, or a URL of the corpus file
  // with the document in its fragment.
  readonly source: string;
  // Null for a corpus that gives no dates. The runner then gives each
  // report of the set the same publish day.
  readonly publishedAt: string | null;
  // The host of the report, where the set has several publishers.
  readonly publisher?: string;
  readonly event: string;
  // The annotator was not sure. alternative is the other label.
  readonly ambiguous?: { readonly alternative: string; readonly note: string };
  // The sha256 of the text that the labels and the scores were made with
  // (textHash).
  readonly textSha256: string;
};

export type TextKind = 'gvc' | 'ecbplus' | 'hlgd' | 'wcep' | 'web';

export type SetMetadata = {
  readonly role: Role;
  // When the labels were frozen, before any design was scored on them.
  readonly frozenAt: string;
  // When a design was first scored on the set. Null for an exam set that
  // was never scored.
  readonly firstScoredAt: string | null;
  // The sha256 of the answer key (labelsHash). A label fix changes it, in a
  // commit that gives the reason.
  readonly labelsSha256: string;
  readonly annotator: string;
  readonly boundaryRule: string;
  readonly text: TextKind;
  readonly source: {
    readonly name: string;
    readonly url: string;
    readonly licence: string;
    readonly attribution: string;
  };
  readonly weaknesses: readonly string[];
};

export type EvalSet = {
  readonly name: string;
  readonly folder: string;
  readonly metadata: SetMetadata;
  readonly rows: readonly AnswerRow[];
};

export type Text = { readonly title: string; readonly body: string };

export const SETS_FOLDER = join(import.meta.dirname, 'sets');

export function setNames(): string[] {
  return readdirSync(SETS_FOLDER).toSorted();
}

export function readSet(name: string): EvalSet {
  const folder = join(SETS_FOLDER, name);
  const metadata: SetMetadata = JSON.parse(
    readFileSync(join(folder, 'set.json'), 'utf8'),
  );
  const rows: AnswerRow[] = JSON.parse(
    readFileSync(join(folder, 'answer-key.json'), 'utf8'),
  );
  const actual = labelsHash(rows);
  if (actual !== metadata.labelsSha256)
    throw new Error(
      `The answer key of ${name} changed (sha256 ${actual}, set.json says ${metadata.labelsSha256}). Write the new sha256 into set.json, and give the reason for the label change in the commit.`,
    );
  return { name, folder, metadata, rows };
}

// The hash of the labels, not of the file bytes, so a new format of the
// file keeps the hash.
export function labelsHash(rows: readonly AnswerRow[]): string {
  return sha256(JSON.stringify(rows));
}

export function textHash(text: Text): string {
  return sha256(JSON.stringify([text.title, text.body]));
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
