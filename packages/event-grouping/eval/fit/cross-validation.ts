import type { Design } from '../../src/index.ts';
import { PAIR_FEATURES } from '../../src/pair-score.ts';
import type { Partition } from '../metrics/contingency.ts';
import { mainScore } from '../metrics/metrics.ts';
import { partitions } from '../score.ts';
import { type Fitted, fit } from './irls.ts';
import type { Candidate } from './rule.ts';
import { best, objective } from './selection.ts';
import type { Stream, TrainingPair } from './stream.ts';

export type Outer = {
  readonly fold: string;
  readonly family: string;
  // The threshold that the inner folds chose, and their objective.
  readonly threshold: number;
  readonly innerObjective: number;
  // The events of the outer fold at that threshold, with the model of the
  // other folds.
  readonly eventOf: Partition;
};

// The nested and the flat cross-validation of one candidate (the objective
// and flatCurve of the selection rule). Each fit of a set of folds is made
// once.
export class CrossValidation {
  readonly #streams: readonly Stream[];
  readonly #pairs: ReadonlyMap<string, readonly TrainingPair[]>;
  readonly #candidate: Candidate;
  readonly #families: ReadonlyMap<string, string>;
  readonly #models = new Map<string, Fitted>();

  constructor(streams: readonly Stream[], candidate: Candidate) {
    this.#streams = streams;
    this.#candidate = candidate;
    this.#pairs = new Map(
      streams.map((stream) => [
        stream.fold.name,
        stream.trainingPairs(candidate.recipe),
      ]),
    );
    this.#families = new Map(
      streams.map(({ fold }) => [fold.name, fold.family]),
    );
  }

  // The objective of scores, one for each fold.
  objective(scores: ReadonlyMap<string, number>): number {
    return objective(scores, this.#families);
  }

  // The model fitted on the pairs of every fold not in excluded.
  model(excluded: readonly string[]): Fitted {
    const key = JSON.stringify(excluded.toSorted());
    let model = this.#models.get(key);
    if (model === undefined) {
      const pairs = this.#streams
        .filter(({ fold }) => !excluded.includes(fold.name))
        .flatMap(({ fold }) => this.#pairs.get(fold.name)!);
      model = fit(
        pairs.map((pair) => pair.features),
        pairs.map((pair) => pair.label),
      );
      this.#models.set(key, model);
    }
    return model;
  }

  // The design of the candidate with the model and the threshold. A fitted
  // design has no plan yet: the plan.json of the fit is its record.
  design(model: Fitted, threshold: number): Design {
    const term = (feature: (typeof PAIR_FEATURES)[number]) => {
      const index = PAIR_FEATURES.indexOf(feature);
      return {
        weight: model.weights[index + 1]!,
        mean: model.mean[index]!,
        sd: model.sd[index]!,
      };
    };
    return {
      ...this.#candidate.recipe,
      planSha256: '',
      threshold,
      pairScore: {
        intercept: model.weights[0]!,
        similarity: term('similarity'),
        agreeingNumbers: term('agreeingNumbers'),
        disagreeingNumbers: term('disagreeingNumbers'),
        samePublisher: term('samePublisher'),
      },
    };
  }

  // The flat curve: for each threshold, the objective of the folds each
  // scored with the model of the other folds. Its best threshold is the final
  // threshold.
  async flat(): Promise<{ threshold: number; value: number }[]> {
    const scores = new Map<string, number[]>();
    for (const stream of this.#streams)
      scores.set(
        stream.fold.name,
        await this.#grid(stream, [stream.fold.name]),
      );
    return this.#candidate.thresholds.map((threshold, index) => ({
      threshold,
      value: this.objective(
        new Map([...scores].map(([fold, values]) => [fold, values[index]!])),
      ),
    }));
  }

  // The nested cross-validation: the threshold of each outer fold is chosen
  // on the other folds, each scored with the model of the folds that are
  // neither of them.
  async nested(): Promise<Outer[]> {
    const outer: Outer[] = [];
    for (const stream of this.#streams) {
      const name = stream.fold.name;
      const inner = new Map<string, number[]>();
      for (const other of this.#streams)
        if (other !== stream)
          inner.set(
            other.fold.name,
            await this.#grid(other, [name, other.fold.name]),
          );
      const chosen = best(
        this.#candidate.thresholds.map((threshold, index) => ({
          threshold,
          value: this.objective(
            new Map([...inner].map(([fold, values]) => [fold, values[index]!])),
          ),
        })),
      );
      outer.push({
        fold: name,
        family: stream.fold.family,
        threshold: chosen.threshold,
        innerObjective: chosen.value,
        eventOf: await stream.run(
          this.design(this.model([name]), chosen.threshold),
        ),
      });
    }
    return outer;
  }

  // The fold score of the stream at each threshold, with the model of the
  // folds that are not excluded.
  async #grid(stream: Stream, excluded: readonly string[]): Promise<number[]> {
    const model = this.model(excluded);
    const scores: number[] = [];
    for (const threshold of this.#candidate.thresholds) {
      const { gold, predicted } = partitions(
        stream.fold.rows,
        await stream.run(this.design(model, threshold)),
      );
      scores.push(mainScore(gold, predicted));
    }
    return scores;
  }
}
