import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@zukhruf/sqlite-transaction';

import { analyse } from './analyse.ts';
import { DAY_MS } from './day.ts';
import type { Design } from './design.ts';
import { EventTable } from './event-table.ts';
import { assign } from './grouping/assign.ts';
import { recluster } from './grouping/recluster.ts';
import { PairScores } from './grouping/scores.ts';
import { Shortlist } from './grouping/shortlist.ts';
import { eventSchema } from './schema.ts';
import type { Vectors } from './vectors.ts';

export type Report = {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly publishedAt: Date;
  // The name of the publisher, for example the host of its site. Two reports
  // of one publisher are evidence against one event (docs/adr/0005). Without
  // a publisher, a report is never of the same publisher as another report.
  readonly publisher?: string;
};

export type Event = {
  readonly id: number;
  // The ids of the reports, in the order of their publish dates.
  readonly members: readonly string[];
  readonly firstSeen: Date;
  readonly lastSeen: Date;
};

export type EventDetectorOptions = {
  // The caller opens and closes the database.
  readonly database: DatabaseSync;
  // The vectors of this detector only. The detector upserts each report with
  // a lead into it.
  readonly vectors: Vectors;
  // The recipe of the grouping. Its weights and threshold belong to the
  // embedding model that it names, so the vectors must come from that model.
  readonly design: Design;
};

// Puts the reports of one real event into one event. Between two publish
// days, a report joins an event by online group average. When a report of a
// new publish day arrives, the detector first clusters the reports of the
// last 7 days again, with group average (docs/adr/0002).
export class EventDetector {
  readonly #database: DatabaseSync;
  readonly #vectors: Vectors;
  readonly #design: Design;
  readonly #table: EventTable;

  constructor(options: EventDetectorOptions) {
    this.#database = options.database;
    this.#vectors = options.vectors;
    this.#design = options.design;
    this.#table = new EventTable(this.#database);
    eventSchema.apply(this.#database);
  }

  // Gives each new report an event, in the order of the publish dates. Equal
  // publish dates keep the order of the array. A report whose id the detector
  // has already is skipped.
  async add(reports: readonly Report[]): Promise<void> {
    const fresh = reports
      .filter((report) => !this.#table.has(report.id))
      .map((report) => analyse(report, this.#design))
      .toSorted((a, b) => a.publishedAt - b.publishedAt);
    const withLead = fresh.flatMap(({ id, day, text }) =>
      text === null ? [] : [{ id, text, publishedAt: new Date(day * DAY_MS) }],
    );
    await this.#vectors.upsert(withLead);

    transaction(
      this.#database,
      () => {
        const design = this.#design;
        const scores = new PairScores(
          this.#table,
          this.#vectors,
          design.pairScore,
        );
        let waiting = withLead.length;
        for (const report of fresh) {
          const shortlist = new Shortlist(
            this.#table,
            this.#vectors,
            design,
            waiting,
          );
          const current = this.#table.currentDay();
          if (current !== undefined && report.day > current)
            recluster(current, this.#table, shortlist, scores, design);
          this.#table.advance(report.day);
          assign(report, this.#table, shortlist, scores, design.threshold);
          if (report.text !== null) waiting--;
        }
      },
      { mode: 'immediate' },
    );
  }

  // The events with a report published at or after since, in the order of
  // their first report.
  events(options: { readonly since: Date }): Event[] {
    const rows = this.#table.rows(options.since.getTime());
    return [...Map.groupBy(rows, (row) => row.event).entries()].map(
      ([id, members]) => ({
        id,
        members: members.map((member) => member.id),
        firstSeen: new Date(members[0]?.publishedAt ?? 0),
        lastSeen: new Date(members.at(-1)?.publishedAt ?? 0),
      }),
    );
  }
}
