import { float32Norm } from '../unit-vectors/float32-norm.ts';
import { ContractError } from './contract-error.ts';
import type {
  IndexValue,
  NearestReferenceAnswer,
  NearestReferenceQuestion,
} from './decision.ts';
import type { Index, LabelledIndex } from './indexes.ts';
import type { StateVectors } from './vectors.ts';

const DEFAULT_K = 5;
const MAX_K = 100;

// Which outcome: the label of the rows of a labelled index nearest to one
// state, as Venn's decide answers NearestReference (venn/server.py:964-986,
// venn/index/decision.py nearest_decision). The scores are the cosines of
// the unit state with the unit rows, rounded to float32, as Venn computes
// them in float32.
export class NearestReference {
  readonly #threshold: number | undefined;
  readonly #temperature: number;
  readonly #k: number;
  readonly #index: LabelledIndex;
  readonly #state: Float32Array;

  // Checks in Venn's order: the index and the state, the labels, then k.
  constructor(
    question: NearestReferenceQuestion,
    index: Index | LabelledIndex,
    state: StateVectors,
    temperature: number,
  ) {
    if (!('outcomes' in index) || !('vector' in state))
      throw new ContractError(
        'nearest_input',
        'NearestReference needs one vector and labeled store',
      );
    if (new Set(index.outcomes.map(String)).size < 2)
      throw new ContractError(
        'nearest_labels',
        'Need at least two reference outcomes',
      );
    const { k = DEFAULT_K } = question;
    if (!(Number.isInteger(k) && k >= 1 && k <= MAX_K))
      throw new ContractError(
        'nearest_k',
        `Reference count must be in 1..${MAX_K}`,
      );
    this.#threshold = question.threshold;
    this.#temperature = temperature;
    this.#k = k;
    this.#index = index;
    this.#state = state.vector;
  }

  answer(): NearestReferenceAnswer {
    const state = NearestReference.#unit(this.#state);
    const scores = this.#index.vectors.map((row) =>
      Math.fround(
        row.reduce((sum, value, i) => sum + value * (state[i] ?? 0), 0),
      ),
    );
    const { label, margin } = NearestReference.#nearestDecision(
      scores,
      this.#index.outcomes,
    );
    // Venn divides in float64 and makes a float32 tensor of the quotient,
    // so the sigmoid is float32 (venn/server.py:970).
    const probability = Math.fround(
      1 / (1 + Math.exp(-Math.fround(margin / this.#temperature))),
    );
    const top = NearestReference.#argsort(scores).reverse().slice(0, this.#k);
    return {
      // >= keeps the label at the threshold, where a Choice gives "none"
      // below it (venn/server.py:976).
      answer:
        this.#threshold === undefined || probability >= this.#threshold
          ? label
          : 'none',
      probabilities: { [label]: probability, none: 1 - probability },
      confidence: probability,
      calibrated: false,
      evidenceIds: top.map((row) => this.#index.ids[row] ?? row),
      margin,
      noneSemantics:
        'cannot affirm nearest outcome; not calibrated corpus-wide OOD',
    };
  }

  // The state divided by its norm, as Venn's x = values /
  // np.linalg.norm(values) (venn/server.py:968). Venn divides by no
  // smallest norm: Vectors refuses a state of norm 0 with zero_vector.
  static #unit(state: Float32Array): Float32Array {
    const norm = float32Norm(state);
    return Float32Array.from(state, (value) => value / norm);
  }

  // The label of the best score of a label, and the margin to the best
  // score of another label, as Venn's nearest_decision gives them. The
  // labels are in the order of np.unique: by value for whole numbers, else
  // the str() of each by its code points.
  static #nearestDecision(
    scores: readonly number[],
    outcomes: readonly IndexValue[],
  ): { readonly label: string; readonly margin: number } {
    const numbers = outcomes.every((outcome) => typeof outcome === 'number');
    const best = new Map<string, { value: IndexValue; score: number }>();
    for (const [row, outcome] of outcomes.entries()) {
      const score = scores[row] ?? Number.NaN;
      const label = String(outcome);
      const seen = best.get(label);
      if (seen === undefined || score > seen.score)
        best.set(label, { value: outcome, score });
    }
    const labels = [...best.entries()].sort(([one, a], [other, b]) =>
      numbers
        ? Number(a.value) - Number(b.value)
        : Buffer.compare(Buffer.from(one), Buffer.from(other)),
    );
    const byLabel = labels.map(([, { score }]) => score);
    const order = NearestReference.#argsort(byLabel);
    const first = order.at(-1) ?? 0;
    const second = order.at(-2) ?? 0;
    return {
      label: labels[first]?.[0] ?? 'none',
      margin: Math.fround((byLabel[first] ?? 0) - (byLabel[second] ?? 0)),
    };
  }

  // The indexes of the values from the smallest, as np.argsort gives them.
  // Its default sort is not stable; this sort is, so a tie keeps the order
  // of the rows. numpy sorts 16 values or fewer by insertion, which is
  // stable too, so there the two agree.
  static #argsort(values: readonly number[]): number[] {
    return values
      .map((_, index) => index)
      .sort((one, other) => (values[one] ?? 0) - (values[other] ?? 0));
  }
}
