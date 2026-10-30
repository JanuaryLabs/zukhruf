import type { AnswerRow, Text } from '../answer-key.ts';
import { detokenize } from './detokenize.ts';
import { pinnedFile } from './pinned-file.ts';
import { type Missing, TextSource } from './text-source.ts';

const COMMIT = '1d80c3a21bb896520dae9e047d70d598279c0df6';
const FILE = `https://raw.githubusercontent.com/cltl/GunViolenceCorpus/${COMMIT}/verbose.conll`;
const SHA256 =
  'd7fc54798b5a9eb9aa4108eb96bc28742bf264c9fa84e642c966b2f91c65e3d8';

// The Gun Violence Corpus (github.com/cltl/GunViolenceCorpus). Each row
// source is the corpus file with the document id as its fragment. The text
// is rebuilt from the tokens of the TITLE and BODY lines, one line for each
// body sentence.
export class GunViolenceCorpus extends TextSource {
  protected async fetch(
    rows: readonly AnswerRow[],
  ): Promise<Map<string, { text: Text; from: string } | Missing>> {
    const { bytes } = await pinnedFile('gvc-verbose.conll', FILE, SHA256);
    const documents = parse(bytes.toString('utf8'));
    return new Map(
      rows.map((row) => {
        const document = documents.get(new URL(row.source).hash.slice(1));
        return [
          row.id,
          document === undefined
            ? { missing: 'The corpus has no such document.' }
            : { text: document, from: FILE },
        ];
      }),
    );
  }
}

function parse(conll: string): Map<string, Text> {
  const documents = new Map<string, Text>();
  let id: string | null = null;
  let title: string[] = [];
  let sentences = new Map<string, string[]>();
  for (const line of conll.split('\n')) {
    if (line.startsWith('#begin document')) {
      id = /\(([^)]+)\)/u.exec(line)?.[1] ?? null;
      title = [];
      sentences = new Map();
    } else if (line.startsWith('#end document')) {
      if (id !== null)
        documents.set(id, {
          title: detokenize(title),
          body: [...sentences.values()]
            .map((tokens) => detokenize(tokens))
            .join('\n'),
        });
      id = null;
    } else if (id !== null && line.trim()) {
      const [tokenId = '', token = '', part] = line.split('\t');
      if (part === 'TITLE') title.push(token);
      else if (part === 'BODY') {
        const sentence = tokenId.split('.')[1] ?? '';
        const tokens = sentences.get(sentence) ?? [];
        tokens.push(token);
        sentences.set(sentence, tokens);
      }
    }
  }
  return documents;
}
