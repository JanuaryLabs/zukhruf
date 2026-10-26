import type { EventTable } from '../event-table.ts';
import { pairScore } from '../pair-score.ts';
import type { Vectors } from '../vectors.ts';

// The pair scores of one add, each one calculated once.
export class PairScores {
  readonly #table: EventTable;
  readonly #vectors: Vectors;
  readonly #numbers = new Map<string, ReadonlySet<string>>();
  readonly #scores = new Map<string, number>();

  constructor(table: EventTable, vectors: Vectors) {
    this.#table = table;
    this.#vectors = vectors;
  }

  // The numbers of a report that is not in the table yet.
  remember(id: string, numbers: ReadonlySet<string>): void {
    this.#numbers.set(id, numbers);
  }

  score(a: string, b: string): number {
    const key = a < b ? JSON.stringify([a, b]) : JSON.stringify([b, a]);
    let score = this.#scores.get(key);
    if (score === undefined) {
      score = pairScore(
        this.#vectors.similarity(a, b),
        this.#numbersOf(a),
        this.#numbersOf(b),
      );
      this.#scores.set(key, score);
    }
    return score;
  }

  #numbersOf(id: string): ReadonlySet<string> {
    let numbers = this.#numbers.get(id);
    if (numbers === undefined) {
      numbers = this.#table.numbersOf(id);
      this.#numbers.set(id, numbers);
    }
    return numbers;
  }
}
