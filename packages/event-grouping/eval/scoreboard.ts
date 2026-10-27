import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Role } from './roles.ts';

export const SCOREBOARD_FILE = join(import.meta.dirname, 'scoreboard.json');

type Score = {
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f05: number;
};

// The scores of one accepted design on one set.
export type SetEntry = {
  readonly role: Role;
  readonly labelsSha256: string;
  readonly reports: number;
  readonly pair: Score;
  readonly bcubed: Score;
};

export type Entry = {
  // The name of the design, for example the research round that froze it.
  readonly design: string;
  readonly acceptedAt: string;
  readonly embeddingModel: string;
  readonly sets: Readonly<Record<string, SetEntry>>;
};

// The accepted designs, the oldest first. A new design becomes an entry
// only when the runner is asked to accept it.
export class Scoreboard {
  readonly entries: readonly Entry[];

  constructor(entries: readonly Entry[]) {
    this.entries = entries;
  }

  static read(): Scoreboard {
    const { entries }: { entries: Entry[] } = JSON.parse(
      readFileSync(SCOREBOARD_FILE, 'utf8'),
    );
    return new Scoreboard(entries);
  }

  // The latest accepted entry that scored the set.
  latest(
    set: string,
  ): { readonly design: string; readonly score: SetEntry } | null {
    const entry = this.entries.findLast((candidate) => set in candidate.sets);
    const score = entry?.sets[set];
    return entry === undefined || score === undefined
      ? null
      : { design: entry.design, score };
  }

  // Why the score must not be accepted, or null. A regression set must not
  // score worse than its latest accepted score, by pair F0.5 or by B-cubed
  // F0.5. A score on other labels compares nothing.
  worse(set: string, score: SetEntry): string | null {
    const latest = this.latest(set);
    if (
      score.role !== 'regression' ||
      latest === null ||
      latest.score.labelsSha256 !== score.labelsSha256
    )
      return null;
    const drops = (['pair', 'bcubed'] as const).filter(
      (kind) => score[kind].f05 < latest.score[kind].f05,
    );
    return drops.length === 0
      ? null
      : `${set} is a regression set, and its ${drops.join(' and ')} F0.5 is lower than design ${latest.design} had.`;
  }

  with(entry: Entry): Scoreboard {
    return new Scoreboard([...this.entries, entry]);
  }

  write(): void {
    writeFileSync(
      SCOREBOARD_FILE,
      `${JSON.stringify({ entries: this.entries }, null, 2)}\n`,
    );
  }
}
