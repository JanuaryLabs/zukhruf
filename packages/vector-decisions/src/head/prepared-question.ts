import { createRequire } from 'node:module';

import type * as Cephes from 'cephes' with { 'resolution-mode': 'require' };

import type { CosineAbstention } from './cosine-abstention.ts';
import { DimensionMismatchError } from './dimension-mismatch-error.ts';

// The smallest norm that F.normalize of PyTorch divides by, so a vector
// that centering makes zero stays zero.
const NORM_EPSILON = 1e-12;

// The CommonJS entry of cephes compiles its WebAssembly synchronously, so
// erf requires it at its first call (as mteb's scipy.ts does).
const require = createRequire(import.meta.url);

// A question whose options are centered and whose part of the "none" network
// is computed once, so that each state costs only its own part, as Venn's
// venn.index.apply.PreparedQuestion does.
export class PreparedQuestion {
  readonly #head: CosineAbstention;
  readonly #options: readonly Float64Array[];
  // The first layer of the "none" network applied to the centered question,
  // with its bias.
  readonly #questionBias: Float64Array;

  constructor(
    head: CosineAbstention,
    question: Float32Array,
    options: readonly Float32Array[],
  ) {
    PreparedQuestion.#checkWidth(head, 'question', question);
    for (const [index, option] of options.entries())
      PreparedQuestion.#checkWidth(head, `option ${index}`, option);
    // prewarm divides by the count of options clamped to 1, so a question
    // with no option has the centroid 0.
    const centroid = Float64Array.from(
      { length: head.width },
      (_, i) =>
        options.reduce((sum, option) => sum + (option[i] ?? 0), 0) /
        Math.max(options.length, 1),
    );
    this.#head = head;
    this.#options = options.map((option) =>
      PreparedQuestion.#centered(option, centroid),
    );
    const centeredQuestion = PreparedQuestion.#centered(question, centroid);
    this.#questionBias = Float64Array.from(head.firstBias, (bias, row) => {
      let sum = bias;
      const start = row * 2 * head.width + head.width;
      for (let i = 0; i < head.width; i++)
        sum += (head.firstWeight[start + i] ?? 0) * (centeredQuestion[i] ?? 0);
      return sum;
    });
  }

  // One row for each unit state: the logit of each option, then the logit
  // of "none".
  logits(states: readonly Float32Array[]): Float64Array[] {
    const head = this.#head;
    return states.map((state, index) => {
      PreparedQuestion.#checkWidth(head, `state ${index}`, state);
      const row = new Float64Array(this.#options.length + 1);
      for (const [option, centered] of this.#options.entries()) {
        let cosine = 0;
        for (let i = 0; i < head.width; i++)
          cosine += (state[i] ?? 0) * (centered[i] ?? 0);
        row[option] = cosine / head.temperature;
      }
      let none = head.secondBias + head.noneIntercept;
      for (let unit = 0; unit < head.hidden; unit++) {
        let sum = this.#questionBias[unit] ?? 0;
        const start = unit * 2 * head.width;
        for (let i = 0; i < head.width; i++)
          sum += (head.firstWeight[start + i] ?? 0) * (state[i] ?? 0);
        none += (head.secondWeight[unit] ?? 0) * PreparedQuestion.#gelu(sum);
      }
      row[this.#options.length] = none;
      return row;
    });
  }

  static #checkWidth(
    head: CosineAbstention,
    name: string,
    vector: Float32Array,
  ): void {
    if (vector.length !== head.width)
      throw new DimensionMismatchError(name, vector.length, head.width);
  }

  // The vector minus the centroid of the options, made a unit vector, as
  // venn.index.prewarm does.
  static #centered(vector: Float32Array, centroid: Float64Array): Float64Array {
    const centered = Float64Array.from(
      centroid,
      (center, i) => (vector[i] ?? 0) - center,
    );
    const norm = Math.max(Math.hypot(...centered), NORM_EPSILON);
    return centered.map((value) => value / norm);
  }

  // nn.GELU of PyTorch, the exact form: x · Φ(x).
  static #gelu(x: number): number {
    const cephes: typeof Cephes = require('cephes');
    return 0.5 * x * (1 + cephes.erf(x / Math.SQRT2));
  }
}
