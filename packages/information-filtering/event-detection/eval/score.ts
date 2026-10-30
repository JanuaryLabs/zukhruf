import type { AnswerRow, Text } from './answer-key.ts';
import { baselines } from './baselines.ts';
import type { Add } from './feed.ts';
import { Contingency, type Partition } from './metrics/contingency.ts';
import type { Score } from './metrics/f-measure.ts';
import { coreferenceLinks } from './metrics/links.ts';
import { type Metrics, metrics } from './metrics/metrics.ts';
import { linkScore } from './metrics/pair.ts';

type Member = {
  readonly id: string;
  readonly publishedAt: string | null;
  readonly publisher: string | null;
  readonly event: string;
  readonly title: string;
};

export type SetScore = Metrics & {
  readonly reports: number;
  readonly goldEvents: number;
  readonly detectorEvents: number;
  // The two partitions that need no detector (#3181).
  readonly baselines: {
    readonly allSingletons: Metrics;
    readonly allInOne: Metrics;
  };
  // Pair scores of the pairs of two publishers, and of the pairs of one
  // publisher. Null when the set has no publishers.
  readonly crossPublisher: Score | null;
  readonly samePublisher: Score | null;
  // The scores on the reports that the annotator was sure of. Null when the
  // set has no ambiguous report.
  readonly withoutAmbiguous: Metrics | null;
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

// The answer key and the events of the detector, on the reports that have a
// text and an event.
export function partitions(
  rows: readonly AnswerRow[],
  eventOf: Partition,
): { readonly gold: Partition; readonly predicted: Partition } {
  const scored = rows.filter((row) => eventOf.has(row.id));
  return {
    gold: new Map(scored.map((row) => [row.id, row.event])),
    predicted: new Map(scored.map((row) => [row.id, eventOf.get(row.id)!])),
  };
}

// Scores the events of the detector against the answer key. Only the
// reports that have a text and an event take part.
export function score(
  rows: readonly AnswerRow[],
  texts: ReadonlyMap<string, Text>,
  eventOf: Partition,
  adds: readonly Add[],
): SetScore {
  const scored = rows.filter((row) => eventOf.has(row.id));
  const { gold, predicted } = partitions(rows, eventOf);
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
  const { allSingletons, allInOne } = baselines(gold);
  const publishers = hasPublishers
    ? publisherPairs(scored, gold, predicted)
    : null;
  return {
    reports: scored.length,
    goldEvents: byGold.size,
    detectorEvents: byPredicted.size,
    ...metrics(gold, predicted),
    baselines: {
      allSingletons: metrics(gold, allSingletons),
      allInOne: metrics(gold, allInOne),
    },
    crossPublisher: publishers?.cross ?? null,
    samePublisher: publishers?.same ?? null,
    withoutAmbiguous:
      sure.length === scored.length
        ? null
        : metrics(restrict(gold, sure), restrict(predicted, sure)),
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

// The links of one publisher are the links within each publisher's reports;
// the links of two publishers are the rest.
function publisherPairs(
  scored: readonly AnswerRow[],
  gold: Partition,
  predicted: Partition,
): { readonly same: Score; readonly cross: Score } {
  const all = coreferenceLinks(new Contingency(gold, predicted));
  const same = { key: 0, response: 0, both: 0 };
  for (const rows of Map.groupBy(
    scored,
    (row) => row.publisher ?? null,
  ).values()) {
    const links = coreferenceLinks(
      new Contingency(restrict(gold, rows), restrict(predicted, rows)),
    );
    same.key += links.key;
    same.response += links.response;
    same.both += links.both;
  }
  return {
    same: linkScore(same),
    cross: linkScore({
      key: all.key - same.key,
      response: all.response - same.response,
      both: all.both - same.both,
    }),
  };
}

function restrict(
  groups: Partition,
  rows: readonly AnswerRow[],
): Map<string, string> {
  return new Map(rows.map((row) => [row.id, groups.get(row.id)!]));
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
