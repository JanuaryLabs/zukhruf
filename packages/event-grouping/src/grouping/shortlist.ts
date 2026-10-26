import type { EventTable } from '../event-table.ts';
import { SHORTLIST_SIZE, WINDOW_DAYS } from '../frozen-design.ts';
import type { Vectors } from '../vectors.ts';

// The nearest reports of a report, from the reports that have an event. An
// add upserts all its reports before it gives them events, so the vectors
// also hold reports with no event yet. The shortlist asks for more neighbours
// until it has SHORTLIST_SIZE reports with an event, or the window has no
// more reports.
export class Shortlist {
  readonly #table: EventTable;
  readonly #vectors: Vectors;
  readonly #waiting: number;

  // waiting: the number of reports of the add that have no event yet.
  constructor(table: EventTable, vectors: Vectors, waiting: number) {
    this.#table = table;
    this.#vectors = vectors;
    this.#waiting = waiting;
  }

  of(id: string): string[] {
    for (let k = SHORTLIST_SIZE + this.#waiting; ; k *= 2) {
      const neighbours = this.#vectors.nearest(id, {
        k,
        withinDays: WINDOW_DAYS,
      });
      const kept = neighbours
        .filter((neighbour) => this.#table.has(neighbour.id))
        .slice(0, SHORTLIST_SIZE)
        .map((neighbour) => neighbour.id);
      if (kept.length === SHORTLIST_SIZE || neighbours.length < k) return kept;
    }
  }
}
