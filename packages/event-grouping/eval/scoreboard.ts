import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Design } from '../src/index.ts';
import type { Interval } from './bootstrap.ts';
import { METRICS_VERSION } from './metrics/metrics.ts';
import type { Role } from './roles.ts';

export const SCOREBOARD_FILE = join(import.meta.dirname, 'scoreboard.json');

type Rounded = {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly f05: number;
};

// The scores of one accepted design on one set, rounded to 3 decimals.
export type SetEntry = {
  readonly role: Role;
  readonly labelsSha256: string;
  readonly reports: number;
  readonly muc: Rounded;
  readonly bCubed: Rounded;
  readonly ceafE: Rounded;
  readonly blanc: Rounded;
  readonly pair: Rounded;
  // conll.f05 is the main score.
  readonly conll: { readonly f1: number; readonly f05: number };
};

// What a design name stands for (#3183): the commit that holds the detector,
// and the design that the detector ran.
export type Pin = {
  readonly commit: string;
  readonly design: Design;
};

export type Entry = {
  // The name of the design, for example the research round that froze it.
  readonly design: string;
  readonly acceptedAt: string;
  // The METRICS_VERSION that the scores were made with.
  readonly metricsVersion: number;
  readonly pin: Pin;
  // How the scores were made, when not by `--accept` of the runner.
  readonly note?: string;
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

  // The latest accepted entry that scored the set. Its scores must be of
  // this metric version, or no change can be computed against them.
  latest(
    set: string,
  ): { readonly entry: Entry; readonly score: SetEntry } | null {
    const entry = this.entries.findLast((candidate) => set in candidate.sets);
    if (entry === undefined) return null;
    if (entry.metricsVersion !== METRICS_VERSION)
      throw new Error(
        `Design ${entry.design} has scores of metric version ${entry.metricsVersion}, and this runner computes version ${METRICS_VERSION}. Score design ${entry.design} again with these metrics first.`,
      );
    return { entry, score: entry.sets[set]! };
  }

  // Why the set must not be accepted, or null. On a regression set, a design
  // is worse than the latest accepted design only when the whole 95%
  // interval of the change of the main score is below 0 (#3182). A score on
  // other labels compares nothing.
  worse(set: string, score: SetEntry, change: Interval): string | null {
    const latest = this.latest(set);
    if (
      score.role !== 'regression' ||
      latest === null ||
      latest.score.labelsSha256 !== score.labelsSha256 ||
      change.high >= 0
    )
      return null;
    return `${set} is a regression set, and the whole 95% interval of the change of its CoNLL F0.5 against design ${latest.entry.design} is below 0 (${change.low.toFixed(3)} to ${change.high.toFixed(3)}).`;
  }

  // A design name stands for one design: a name that is in the scoreboard
  // cannot be accepted again.
  with(entry: Entry): Scoreboard {
    const same = this.entries.find(
      (candidate) => candidate.design === entry.design,
    );
    if (same !== undefined)
      throw new Error(
        sameDesign(same.pin.design, entry.pin.design)
          ? `Design ${entry.design} is accepted already, with this design.`
          : `Design ${entry.design} is accepted already with another design. Give the new design its own name.`,
      );
    return new Scoreboard([...this.entries, entry]);
  }

  // The accepted entry of the design, or null.
  designOf(design: Design): Entry | null {
    return (
      this.entries.findLast((entry) => sameDesign(entry.pin.design, design)) ??
      null
    );
  }

  write(): void {
    writeFileSync(
      SCOREBOARD_FILE,
      `${JSON.stringify({ entries: this.entries }, null, 2)}\n`,
    );
  }
}

function sameDesign(a: Design, b: Design): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
