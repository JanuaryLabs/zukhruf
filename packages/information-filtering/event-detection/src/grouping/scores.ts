import type { Design } from '../design.ts';
import type { EventTable } from '../event-table.ts';
import { type Evidence, pairFeatures, pairScore } from '../pair-score.ts';
import type { Vectors } from '../vectors.ts';

// The pair scores of one add, each one calculated once.
export class PairScores {
  readonly #table: EventTable;
  readonly #vectors: Vectors;
  readonly #model: Design['pairScore'];
  readonly #evidence = new Map<string, Evidence>();
  readonly #scores = new Map<string, number>();

  constructor(table: EventTable, vectors: Vectors, model: Design['pairScore']) {
    this.#table = table;
    this.#vectors = vectors;
    this.#model = model;
  }

  // The evidence of a report that is not in the table yet.
  remember(id: string, evidence: Evidence): void {
    this.#evidence.set(id, evidence);
  }

  // similarity: the cosine similarity of a and b, when the caller has it
  // already. Without it, the score asks the vectors.
  score(a: string, b: string, similarity?: number): number {
    const key = a < b ? JSON.stringify([a, b]) : JSON.stringify([b, a]);
    let score = this.#scores.get(key);
    if (score === undefined) {
      score = pairScore(
        this.#model,
        pairFeatures(
          similarity ?? this.#vectors.similarity(a, b),
          this.#evidenceOf(a),
          this.#evidenceOf(b),
        ),
      );
      this.#scores.set(key, score);
    }
    return score;
  }

  #evidenceOf(id: string): Evidence {
    let evidence = this.#evidence.get(id);
    if (evidence === undefined) {
      evidence = this.#table.evidenceOf(id);
      this.#evidence.set(id, evidence);
    }
    return evidence;
  }
}
