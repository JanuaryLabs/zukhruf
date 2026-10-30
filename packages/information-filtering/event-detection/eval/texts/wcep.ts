import type { AnswerRow, Text } from '../answer-key.ts';
import { USER_AGENT } from './pinned-file.ts';
import { type Missing, TextSource } from './text-source.ts';

type Rows = {
  readonly rows: readonly { readonly row: { document: string } }[];
};

const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });

// Rows of the WCEP test split (allenai/wcep_dense_max on Hugging Face). Each
// row source is a datasets-server rows URL for one dataset row, with the
// index of the report in the row as its fragment. A row holds its reports
// separated by "</s>". The title is the first sentence of the first line of
// the report, as the round that labelled the set took it.
export class WcepRows extends TextSource {
  protected async fetch(
    rows: readonly AnswerRow[],
  ): Promise<Map<string, { text: Text; from: string } | Missing>> {
    const documents = new Map<string, readonly string[] | Missing>();
    for (const url of new Set(rows.map((row) => sourceUrl(row))))
      documents.set(url, await download(url));
    return new Map(
      rows.map((row): [string, { text: Text; from: string } | Missing] => {
        const url = sourceUrl(row);
        const reports = documents.get(url) ?? { missing: 'No row.' };
        if ('missing' in reports) return [row.id, reports];
        const body = reports[Number(new URL(row.source).hash.slice(1))];
        if (body === undefined)
          return [row.id, { missing: 'The row has no such report.' }];
        const firstLine = body.split('\n')[0] ?? '';
        const title =
          sentences.segment(firstLine)[Symbol.iterator]().next().value
            ?.segment ?? '';
        return [row.id, { text: { title: title.trim(), body }, from: url }];
      }),
    );
  }
}

function sourceUrl(row: AnswerRow): string {
  const url = new URL(row.source);
  url.hash = '';
  return url.href;
}

async function download(url: string): Promise<readonly string[] | Missing> {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) return { missing: `HTTP ${response.status}` };
  const { rows }: Rows = JSON.parse(await response.text());
  const document = rows[0]?.row.document;
  if (document === undefined)
    return { missing: 'The dataset has no such row.' };
  return document.split('</s>').map((report) => report.trim());
}
