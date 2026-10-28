import { DatabaseSync } from 'node:sqlite';

import {
  type Design,
  EventDetector,
  type Report,
  type Vectors,
} from '../src/index.ts';
import type { AnswerRow, Text } from './answer-key.ts';

const DAY_MS = 86_400_000;
// The publish date of each report of a corpus that gives no dates. The
// reports then share one publish day, and one clustering of the window
// groups them all.
const UNDATED = new Date('2000-01-01T00:00:00Z');
const FLUSH = '\u0000flush';

export type Add = {
  readonly day: string;
  readonly reports: number;
  readonly ms: number;
};

export type Feed = {
  // The event of each report, from the detector.
  readonly eventOf: ReadonlyMap<string, string>;
  readonly adds: readonly Add[];
};

// Feeds the reports to a detector as a host does: one add for each publish
// day, in the order of the publish dates. Equal dates keep the order of the
// answer key. The detector state is new for each feed; the vectors and the
// design are those of the caller. After the last day, one headline-only report of the
// next day makes the detector cluster the last window again, so the events
// of the last day are final. That report never joins an event (ADR 0003).
export async function feed(
  rows: readonly AnswerRow[],
  texts: ReadonlyMap<string, Text>,
  vectors: Vectors,
  design: Design,
): Promise<Feed> {
  const sorted = reportsOf(rows, texts).toSorted(
    (a, b) => a.publishedAt.getTime() - b.publishedAt.getTime(),
  );
  using database = new DatabaseSync(':memory:');
  const detector = new EventDetector({ database, vectors, design });
  const adds: Add[] = [];
  for (const [day, batch] of Map.groupBy(sorted, (report) =>
    report.publishedAt.toISOString().slice(0, 10),
  )) {
    const started = performance.now();
    await detector.add(batch);
    adds.push({ day, reports: batch.length, ms: performance.now() - started });
  }
  const last = sorted.at(-1)?.publishedAt.getTime() ?? 0;
  await detector.add([
    {
      id: FLUSH,
      title: 'Flush',
      body: '',
      publishedAt: new Date(Math.floor(last / DAY_MS + 1) * DAY_MS),
    },
  ]);
  const eventOf = new Map<string, string>();
  for (const event of detector.events({ since: new Date(0) }))
    for (const member of event.members)
      if (member !== FLUSH) eventOf.set(member, String(event.id));
  return { eventOf, adds };
}

// The report of each row that has a text, in the order of the rows.
export function reportsOf(
  rows: readonly AnswerRow[],
  texts: ReadonlyMap<string, Text>,
): Report[] {
  return rows.flatMap((row) => {
    const text = texts.get(row.id);
    return text === undefined
      ? []
      : [
          {
            id: row.id,
            title: text.title,
            body: text.body,
            publishedAt:
              row.publishedAt === null ? UNDATED : new Date(row.publishedAt),
            ...(row.publisher !== undefined && { publisher: row.publisher }),
          },
        ];
  });
}
