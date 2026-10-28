import type { AnswerRow, Text } from '../answer-key.ts';
import type { FoldRule } from './rule.ts';

// The labelled reports of one set, with their texts.
export type LoadedSet = {
  readonly name: string;
  readonly rows: readonly AnswerRow[];
  readonly texts: ReadonlyMap<string, Text>;
};

export type Fold = LoadedSet & { readonly family: string };

// The folds of each family, in the order of the rule.
export function foldsOf(
  rules: readonly FoldRule[],
  sets: ReadonlyMap<string, LoadedSet>,
): Fold[] {
  return rules.flatMap((rule) => {
    const loaded = rule.sets.map((name) => {
      const set = sets.get(name);
      if (set === undefined) throw new Error(`The fit loaded no set ${name}.`);
      return set;
    });
    const rows = loaded.flatMap((set) => set.rows);
    const texts = new Map(loaded.flatMap((set) => [...set.texts]));
    const foldOf = split(rule, rows);
    return Array.from({ length: rule.count }, (_, index) => ({
      name: `${rule.family}-${index}`,
      family: rule.family,
      rows: rows.filter((row) => foldOf(row) === index),
      texts,
    }));
  });
}

function split(
  rule: FoldRule,
  rows: readonly AnswerRow[],
): (row: AnswerRow) => number {
  switch (rule.split) {
    case 'none':
      return () => 0;
    case 'topic': {
      const topicOf = (row: AnswerRow) => {
        const match = /^ecb-(\d+)_/u.exec(row.id);
        if (match === null) throw new Error(`${row.id} names no ECB+ topic.`);
        return Number(match[1]);
      };
      const topics = [...new Set(rows.map(topicOf))].toSorted((a, b) => a - b);
      return (row) => topics.indexOf(topicOf(row)) % rule.count;
    }
    case 'time': {
      // Each gold event goes to the fold of the reports before it, so a fold
      // holds whole events and about rows / count reports.
      const first = new Map<string, string>();
      for (const row of rows) {
        if (row.publishedAt === null)
          throw new Error(`${row.id} has no date for a time fold.`);
        const seen = first.get(row.event);
        if (seen === undefined || row.publishedAt < seen)
          first.set(row.event, row.publishedAt);
      }
      const size = Map.groupBy(rows, (row) => row.event);
      const foldOfEvent = new Map<string, number>();
      let before = 0;
      for (const event of [...first.keys()].toSorted(
        (a, b) =>
          first.get(a)!.localeCompare(first.get(b)!) || a.localeCompare(b),
      )) {
        foldOfEvent.set(
          event,
          Math.min(
            rule.count - 1,
            Math.floor(before / (rows.length / rule.count)),
          ),
        );
        before += size.get(event)!.length;
      }
      return (row) => foldOfEvent.get(row.event)!;
    }
  }
}
