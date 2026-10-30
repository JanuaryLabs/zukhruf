import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AnswerRow, Text } from '../answer-key.ts';
import { detokenize } from './detokenize.ts';
import { pinnedFile } from './pinned-file.ts';
import { type Missing, TextSource } from './text-source.ts';

const COMMIT = '3aa071e12fd08fc0705b16bb1841e7a9c5c22420';
const FILE = `https://raw.githubusercontent.com/cltl/ecbPlus/${COMMIT}/ECB+_LREC2014/ECB+.zip`;
const SHA256 =
  'fe6ac2d76d8f7015f773ccc969927d7f3c33b331ed643b71efe31f28373eca90';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

// The ECB+ corpus (github.com/cltl/ecbPlus). Each row source is the zip file
// with the document path as its fragment. The text is rebuilt from the
// token elements, one line for each sentence. ECB+ has no titles, so the
// detector takes the first real sentence as the title.
export class EcbPlusCorpus extends TextSource {
  protected async fetch(
    rows: readonly AnswerRow[],
  ): Promise<Map<string, { text: Text; from: string } | Missing>> {
    const { path } = await pinnedFile('ECB+.zip', FILE, SHA256);
    const folder = `${path}.unzipped`;
    if (!existsSync(folder))
      execFileSync('unzip', ['-q', '-o', path, '-d', folder]);
    return new Map(
      rows.map((row) => {
        const file = join(
          folder,
          decodeURIComponent(new URL(row.source).hash.slice(1)),
        );
        return [
          row.id,
          existsSync(file)
            ? { text: { title: '', body: body(file) }, from: FILE }
            : { missing: 'The corpus has no such document.' },
        ];
      }),
    );
  }
}

function body(file: string): string {
  const sentences = new Map<number, string[]>();
  const xml = readFileSync(file, 'utf8');
  for (const [, sentence = '', token = ''] of xml.matchAll(
    /<token [^>]*\bsentence="(\d+)"[^>]*>([^<]*)<\/token>/gu,
  )) {
    const tokens = sentences.get(Number(sentence)) ?? [];
    tokens.push(
      token.trim().replace(/&(\w+);/gu, (entity, name: string) => {
        return ENTITIES[name] ?? entity;
      }),
    );
    sentences.set(Number(sentence), tokens);
  }
  return [...sentences.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([, tokens]) => detokenize(tokens))
    .join('\n');
}
