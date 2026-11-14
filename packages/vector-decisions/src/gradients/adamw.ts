import type { Parameter } from './parameter.ts';

// The options that Venn sets; betas and eps stay at the defaults of PyTorch.
export type AdamWOptions = {
  readonly lr?: number;
  readonly weightDecay?: number;
};

type Moments = {
  readonly parameter: Parameter;
  readonly expAvg: Float64Array;
  readonly expAvgSq: Float64Array;
};

const BETA1 = 0.9;
const BETA2 = 0.999;
const EPS = 1e-8;

// torch.optim.AdamW of PyTorch 2.15.0 (Loshchilov and Hutter, "Decoupled
// Weight Decay Regularization"), each step in the order of its single-tensor
// path, which the CPU runs (torch/optim/adam.py, _single_tensor_adam): first
// the decay p ← p · (1 − lr · weight decay), then Adam with bias correction.
export class AdamW {
  readonly #moments: readonly Moments[];
  readonly #lr: number;
  readonly #weightDecay: number;
  #step = 0;

  constructor(
    parameters: readonly Parameter[],
    { lr = 1e-3, weightDecay = 1e-2 }: AdamWOptions = {},
  ) {
    this.#moments = parameters.map((parameter) => ({
      parameter,
      expAvg: new Float64Array(parameter.value.values.length),
      expAvgSq: new Float64Array(parameter.value.values.length),
    }));
    this.#lr = lr;
    this.#weightDecay = weightDecay;
  }

  step(): void {
    this.#step += 1;
    const lr = this.#lr;
    const decay = 1 - lr * this.#weightDecay;
    const stepSize = lr / (1 - BETA1 ** this.#step);
    const biasCorrection2Sqrt = (1 - BETA2 ** this.#step) ** 0.5;
    for (const { parameter, expAvg, expAvgSq } of this.#moments) {
      const values = parameter.value.values;
      for (const [index, gradient] of parameter.gradient.values.entries()) {
        const average = expAvg[index] ?? 0;
        const averageSq = expAvgSq[index] ?? 0;
        // lerp(m, g, 1 − β1) and v · β2 + (1 − β2) · g · g, as PyTorch
        // writes them.
        const m = average + (1 - BETA1) * (gradient - average);
        const v = averageSq * BETA2 + (1 - BETA2) * gradient * gradient;
        expAvg[index] = m;
        expAvgSq[index] = v;
        const denominator = Math.sqrt(v) / biasCorrection2Sqrt + EPS;
        values[index] =
          (values[index] ?? 0) * decay + (-stepSize * m) / denominator;
      }
    }
  }

  // PyTorch sets each gradient to None, and step skips a parameter whose
  // gradient is None. In the heads of Venn each step gives a gradient to
  // every parameter, so a gradient of zeros gives the same steps.
  zeroGrad(): void {
    for (const { parameter } of this.#moments)
      parameter.gradient.values.fill(0);
  }
}
