import type { AnswerRow, Text } from '../answer-key.ts';
import { pinnedFile } from './pinned-file.ts';
import { type Missing, TextSource } from './text-source.ts';

const FILE =
  'https://github.com/tingofurro/headline_grouping/releases/download/0.1/hlgd_original_annotations.json';
const SHA256 =
  '38650230e9192650fd0ba7e56915042dba3e807a95b1254d368f1e272e94f455';

type Annotation = { readonly headline: string };

// The original annotations of the Headline Grouping dataset (HLGD,
// github.com/tingofurro/headline_grouping, release 0.1). Each row source is
// the annotation file with the index of the headline as its fragment. HLGD
// gives headlines only, so the title and the body are both the headline.
export class HeadlineGroupingRelease extends TextSource {
  protected async fetch(
    rows: readonly AnswerRow[],
  ): Promise<Map<string, { text: Text; from: string } | Missing>> {
    const { bytes } = await pinnedFile(
      'hlgd_original_annotations.json',
      FILE,
      SHA256,
    );
    const annotations: Annotation[] = JSON.parse(bytes.toString('utf8'));
    return new Map(
      rows.map((row) => {
        const annotation =
          annotations[Number(new URL(row.source).hash.slice(1))];
        return [
          row.id,
          annotation === undefined
            ? { missing: 'The release has no such headline.' }
            : {
                text: { title: annotation.headline, body: annotation.headline },
                from: FILE,
              },
        ];
      }),
    );
  }
}
