import { DAY_MS } from '../day.ts';
import type { EventTable } from '../event-table.ts';
import { SHORTLIST_SIZE, WINDOW_DAYS } from '../frozen-design.ts';
import type { Neighbour, Vectors } from '../vectors.ts';

// The nearest reports of a report, from the reports that have an event. An
// add upserts all its reports before it gives them events, so the vectors
// also hold reports with no event yet. The shortlist asks for more neighbours
// until it has SHORTLIST_SIZE reports with an event, or the window has no
// more reports.
export class Shortlist {
  readonly #table: EventTable;
  readonly #vectors: Vectors;
  readonly #k: number;

  // waiting: the number of reports of the add that have no event yet.
  constructor(table: EventTable, vectors: Vectors, waiting: number) {
    this.#table = table;
    this.#vectors = vectors;
    this.#k = SHORTLIST_SIZE + waiting;
  }

  of(id: string): Neighbour[] {
    return this.#widen(
      id,
      this.#vectors.nearest(id, { k: this.#k, withinDays: WINDOW_DAYS }),
    );
  }

  // The shortlists of the reports published from the first day to the last
  // day, from one neighbour graph of the vectors.
  ofDays(first: number, last: number): Map<string, Neighbour[]> {
    const graph = this.#vectors.neighbourGraph({
      from: new Date(first * DAY_MS),
      to: new Date(last * DAY_MS),
      k: this.#k,
      withinDays: WINDOW_DAYS,
    });
    return new Map(
      Iterator.from(graph).map(([id, neighbours]) => [
        id,
        this.#widen(id, neighbours),
      ]),
    );
  }

  // first: the neighbours for this.#k. Each next ask doubles k.
  #widen(id: string, first: readonly Neighbour[]): Neighbour[] {
    let neighbours = first;
    let k = this.#k;
    while (true) {
      const kept = neighbours
        .values()
        .filter((neighbour) => this.#table.has(neighbour.id))
        .take(SHORTLIST_SIZE)
        .toArray();
      if (kept.length === SHORTLIST_SIZE || neighbours.length < k) return kept;
      k *= 2;
      neighbours = this.#vectors.nearest(id, { k, withinDays: WINDOW_DAYS });
    }
  }
}
