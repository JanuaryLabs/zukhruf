import type { AnswerRow, Text } from './answer-key.ts';
import type { Add } from './feed.ts';
import {
  type BCubedScore,
  type PairScore,
  bcubedScore,
  pairScore,
} from './metrics.ts';

export type Scores = {
  readonly pair: PairScore;
  readonly bcubed: BCubedScore;
};

type Member = {
  readonly id: string;
  readonly publishedAt: string | null;
  readonly publisher: string | null;
  readonly event: string;
  readonly title: string;
};

export type SetScore = Scores & {
  readonly reports: number;
  readonly goldEvents: number;
  readonly detectorEvents: number;
  // Pairs of two publishers, and pairs of one publisher. Null when the set
  // has no publishers.
  readonly crossPublisher: PairScore | null;
  readonly samePublisher: PairScore | null;
  // The scores on the reports that the annotator was sure of. Null when the
  // set has no ambiguous report.
  readonly withoutAmbiguous: Scores | null;
  readonly addMs: {
    readonly adds: number;
    readonly median: number;
    readonly p90: number;
    readonly max: number;
    readonly total: number;
    readonly medianPerReport: number;
  };
  // Detector events that hold reports of more than one gold event, the
  // most wrong pairs first.
  readonly falseJoins: readonly {
    readonly wrongPairs: number;
    readonly members: readonly Member[];
  }[];
  // Gold events whose reports are in more than one detector event, the
  // most missed pairs first.
  readonly falseSplits: readonly {
    readonly event: string;
    readonly missedPairs: number;
    readonly parts: readonly (readonly Member[])[];
  }[];
};

// Scores the events of the detector against the answer key. Only the
// reports that have a text and an event take part.
export function score(
  rows: readonly AnswerRow[],
  texts: ReadonlyMap<string, Text>,
  eventOf: ReadonlyMap<string, string>,
  adds: readonly Add[],
): SetScore {
  const scored = rows.filter((row) => eventOf.has(row.id));
  const gold = new Map(scored.map((row) => [row.id, row.event]));
  const predicted = new Map(
    scored.map((row) => [row.id, eventOf.get(row.id) ?? '']),
  );
  const publisher = new Map(
    scored.map((row) => [row.id, row.publisher ?? null]),
  );
  const hasPublishers = scored.some((row) => row.publisher !== undefined);
  const sure = scored.filter((row) => row.ambiguous === undefined);
  const member = (row: AnswerRow): Member => ({
    id: row.id,
    publishedAt: row.publishedAt,
    publisher: row.publisher ?? null,
    event: row.event,
    title: texts.get(row.id)?.title ?? '',
  });
  const byPredicted = Map.groupBy(scored, (row) => predicted.get(row.id));
  const byGold = Map.groupBy(scored, (row) => row.event);
  const ms = adds.map((add) => add.ms).toSorted((a, b) => a - b);
  const perReport = adds
    .map((add) => add.ms / add.reports)
    .toSorted((a, b) => a - b);
  return {
    reports: scored.length,
    goldEvents: byGold.size,
    detectorEvents: byPredicted.size,
    ...scores(gold, predicted),
    crossPublisher: hasPublishers
      ? pairScore(
          gold,
          predicted,
          (a, b) => publisher.get(a) !== publisher.get(b),
        )
      : null,
    samePublisher: hasPublishers
      ? pairScore(
          gold,
          predicted,
          (a, b) => publisher.get(a) === publisher.get(b),
        )
      : null,
    withoutAmbiguous:
      sure.length === scored.length
        ? null
        : scores(restrict(gold, sure), restrict(predicted, sure)),
    addMs: {
      adds: ms.length,
      median: ms[Math.floor(ms.length / 2)] ?? 0,
      p90: ms[Math.floor(ms.length * 0.9)] ?? 0,
      max: ms.at(-1) ?? 0,
      total: ms.reduce((sum, value) => sum + value, 0),
      medianPerReport: perReport[Math.floor(perReport.length / 2)] ?? 0,
    },
    falseJoins: [...byPredicted.values()]
      .filter((members) => new Set(members.map((row) => row.event)).size > 1)
      .map((members) => ({
        wrongPairs: pairs(members, (a, b) => a.event !== b.event),
        members: members.map(member),
      }))
      .toSorted((a, b) => b.wrongPairs - a.wrongPairs),
    falseSplits: [...byGold.entries()]
      .map(([event, members]) => ({
        event,
        missedPairs: pairs(
          members,
          (a, b) => predicted.get(a.id) !== predicted.get(b.id),
        ),
        parts: [
          ...Map.groupBy(members, (row) => predicted.get(row.id)).values(),
        ].map((part) => part.map(member)),
      }))
      .filter((split) => split.parts.length > 1)
      .toSorted((a, b) => b.missedPairs - a.missedPairs),
  };
}

function scores(
  gold: ReadonlyMap<string, string>,
  predicted: ReadonlyMap<string, string>,
): Scores {
  return {
    pair: pairScore(gold, predicted),
    bcubed: bcubedScore(gold, predicted),
  };
}

function restrict(
  groups: ReadonlyMap<string, string>,
  rows: readonly AnswerRow[],
): Map<string, string> {
  return new Map(rows.map((row) => [row.id, groups.get(row.id) ?? '']));
}

function pairs<T>(
  items: readonly T[],
  counts: (a: T, b: T) => boolean,
): number {
  let count = 0;
  for (const [index, a] of items.entries())
    for (const b of items.slice(index + 1)) if (counts(a, b)) count++;
  return count;
}
