import type { Tensor } from '../safetensors/load-weights.ts';
import { InvalidHeadWeightsError } from './invalid-head-weights-error.ts';

// The head of Venn (venn/heads/abstention.py): option logits are the
// cosines of the state with the centered options, divided by `temperature`,
// and the "none" logit comes from a network of two layers over the state and
// the centered question, plus `noneIntercept`.
export class CosineAbstention {
  // The numbers of a vector that the head reads.
  readonly width: number;
  readonly hidden: number;
  readonly temperature: number;
  readonly noneIntercept: number;
  // none.0: hidden × (2 × width), row-major; the state half comes first.
  readonly firstWeight: Float32Array;
  readonly firstBias: Float32Array;
  // none.2: 1 × hidden.
  readonly secondWeight: Float32Array;
  readonly secondBias: number;

  private constructor(weights: ReadonlyMap<string, Tensor>) {
    const first = CosineAbstention.#tensor(weights, 'none.0.weight');
    const [hidden = 0, inputs = 0] = first.shape;
    if (first.shape.length !== 2 || inputs % 2 !== 0)
      throw new InvalidHeadWeightsError(
        'none.0.weight',
        `has the shape [${first.shape.join(', ')}], but the head needs [hidden, 2 × width]`,
      );
    this.width = inputs / 2;
    this.hidden = hidden;
    this.firstWeight = first.values;
    this.firstBias = CosineAbstention.#fitted(weights, 'none.0.bias', [hidden]);
    this.secondWeight = CosineAbstention.#fitted(weights, 'none.2.weight', [
      1,
      hidden,
    ]);
    this.secondBias = CosineAbstention.#scalar(weights, 'none.2.bias', [1]);
    this.temperature = CosineAbstention.#scalar(weights, 'temperature', []);
    this.noneIntercept = CosineAbstention.#scalar(
      weights,
      'none_intercept',
      [],
    );
  }

  // The head of the weights that loadWeights reads from its safetensors file.
  static fromWeights(weights: ReadonlyMap<string, Tensor>): CosineAbstention {
    return new CosineAbstention(weights);
  }

  static #tensor(weights: ReadonlyMap<string, Tensor>, name: string): Tensor {
    const tensor = weights.get(name);
    if (tensor === undefined)
      throw new InvalidHeadWeightsError(name, 'is missing');
    return tensor;
  }

  static #fitted(
    weights: ReadonlyMap<string, Tensor>,
    name: string,
    shape: readonly number[],
  ): Float32Array {
    const tensor = CosineAbstention.#tensor(weights, name);
    if (
      tensor.shape.length !== shape.length ||
      tensor.shape.some((size, axis) => size !== shape[axis])
    )
      throw new InvalidHeadWeightsError(
        name,
        `has the shape [${tensor.shape.join(', ')}], but the head needs [${shape.join(', ')}]`,
      );
    return tensor.values;
  }

  static #scalar(
    weights: ReadonlyMap<string, Tensor>,
    name: string,
    shape: readonly number[],
  ): number {
    const [value = Number.NaN] = CosineAbstention.#fitted(weights, name, shape);
    return value;
  }
}
