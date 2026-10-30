import type { Threshold } from './threshold.ts';

// The Bayes decision rule on calibrated probabilities (Lewis, SIGIR 1995).
// Accepting an article with the probability p costs falseAlarm * (1 - p) on
// average, and missing it costs miss * p, so the rule accepts when
// p >= falseAlarm / (falseAlarm + miss). The reader sets the two costs, for
// example per action: a notification costs more than a mark.
export class UtilityThreshold implements Threshold {
  readonly #cut: number;

  constructor(options: { readonly falseAlarm: number; readonly miss: number }) {
    const { falseAlarm, miss } = options;
    if (
      !Number.isFinite(falseAlarm) ||
      !Number.isFinite(miss) ||
      falseAlarm < 0 ||
      miss < 0 ||
      falseAlarm + miss === 0
    )
      throw new RangeError(
        `The costs ${falseAlarm} and ${miss} give no threshold. Give two finite costs of 0 or more, and not both 0.`,
      );
    this.#cut = falseAlarm / (falseAlarm + miss);
  }

  cut(): number {
    return this.#cut;
  }
}
