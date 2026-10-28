import { DatabaseSync } from 'node:sqlite';

import type { EmbeddingModel } from 'ai';

import { Collection } from '@zukhruf/embeddings';

import { analyse } from '../../src/analyse.ts';
import { DAY_MS } from '../../src/day.ts';
import type { Design } from '../../src/index.ts';
import { PAIR_FEATURES, pairFeatures } from '../../src/pair-score.ts';
import { vectorCache } from '../embedding-model.ts';
import { feed, reportsOf } from '../feed.ts';
import type { Partition } from '../metrics/contingency.ts';
import type { Fold } from './folds.ts';

export type TrainingPair = {
  // The pair features, in the order of PAIR_FEATURES.
  readonly features: readonly number[];
  // 1 when the answer key puts the two reports in one event.
  readonly label: number;
};

// The reports of one fold and their vectors, in a database of their own, so
// a shortlist holds only reports of the fold. The vectors are copies of the
// rows of the vector caches of the model for the sets of the fold
// (cache/vectors/<model>/<set>.sqlite), which the fit fills first. The model embeds
// nothing then: each lead of the fold is in the copy.
export class Stream {
  readonly fold: Fold;
  readonly #database: DatabaseSync;
  readonly #vectors: Collection;

  private constructor(fold: Fold, database: DatabaseSync, vectors: Collection) {
    this.fold = fold;
    this.#database = database;
    this.#vectors = vectors;
  }

  static open(
    fold: Fold,
    sets: readonly string[],
    design: Pick<Design, 'embeddingModel'>,
    model: Exclude<EmbeddingModel, string>,
  ): Stream {
    const database = new DatabaseSync(':memory:');
    const vectors = new Collection({ database, model });
    const ids = JSON.stringify(fold.rows.map((row) => row.id));
    for (const set of sets) {
      database
        .prepare('ATTACH DATABASE ? AS "cache"')
        .run(vectorCache(design.embeddingModel, set));
      database
        .prepare(
          `INSERT INTO "embedding_document" ("id", "hash", "published_at", "vector")
          SELECT "id", "hash", "published_at", "vector" FROM "cache"."embedding_document"
          WHERE "id" IN (SELECT "value" FROM json_each(?))`,
        )
        .run(ids);
      database.exec('DETACH DATABASE "cache"');
    }
    return new Stream(fold, database, vectors);
  }

  // The batch shortlist pairs: for each report with a lead, its nearest
  // shortlistSize reports with a lead within windowDays, from the neighbour
  // graph of the fold. Each pair once.
  trainingPairs(
    design: Pick<
      Design,
      'lead' | 'vectorText' | 'shortlistSize' | 'windowDays'
    >,
  ): TrainingPair[] {
    const reports = new Map(
      reportsOf(this.fold.rows, this.fold.texts).map((report) => [
        report.id,
        analyse(report, design),
      ]),
    );
    const eventOf = new Map(this.fold.rows.map((row) => [row.id, row.event]));
    const days = [...reports.values()].map((report) => report.day);
    const seen = new Set<string>();
    const pairs: TrainingPair[] = [];
    for (const [id, neighbours] of this.#vectors.neighbourGraph({
      from: new Date(Math.min(...days) * DAY_MS),
      to: new Date(Math.max(...days) * DAY_MS),
      k: design.shortlistSize,
      withinDays: design.windowDays,
    }))
      for (const neighbour of neighbours) {
        const key = JSON.stringify([id, neighbour.id].toSorted());
        if (seen.has(key)) continue;
        seen.add(key);
        const features = pairFeatures(
          neighbour.similarity,
          reports.get(id)!,
          reports.get(neighbour.id)!,
        );
        pairs.push({
          features: PAIR_FEATURES.map((feature) => features[feature]),
          label: Number(eventOf.get(id) === eventOf.get(neighbour.id)),
        });
      }
    return pairs;
  }

  // The events that the detector gives the reports of the fold with the
  // design, fed as a host feeds it.
  async run(design: Design): Promise<Partition> {
    return (await feed(this.fold.rows, this.fold.texts, this.#vectors, design))
      .eventOf;
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}
