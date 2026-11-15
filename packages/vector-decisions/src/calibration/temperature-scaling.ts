import { CrossEntropyLoss } from '../gradients/cross-entropy-loss.ts';
import type { Trainable } from '../gradients/differentiable.ts';
import { LBFGS } from '../gradients/lbfgs.ts';
import { Matrix } from '../gradients/matrix.ts';
import { Parameter } from '../gradients/parameter.ts';

// The bounds of the logarithm of the temperature: e^-5 to e^5.
const LOG_BOUND = 5;

// Temperature scaling (Guo et al. 2017, "On Calibration of Modern Neural
// Networks", §4.2): the logits divided by one temperature T. The parameter is
// log T, which the forward pass clamps to [−5, 5], as Venn does. The clamp
// passes the gradient of log T clamped (a straight-through clamp), where
// PyTorch's clamp in Venn's fit passes 0 outside it: there a step of LBFGS
// past −5 meets a gradient of 0 and the fit stops at e^-5, far from the best
// temperature (venn-vdm 7b2042e, venn/heads/calibration.py:19; ADR 0006).
export class TemperatureScaling {
  readonly logTemperature = new Parameter(new Matrix(1, 1));

  get temperature(): number {
    const [value = 0] = this.logTemperature.value.values;
    return Math.exp(Math.min(Math.max(value, -LOG_BOUND), LOG_BOUND));
  }

  forward(logits: Matrix): Trainable<Matrix> {
    const temperature = this.temperature;
    return {
      output: new Matrix(
        logits.rows,
        logits.columns,
        logits.values.map((logit) => logit / temperature),
      ),
      accumulate: (gradient) => {
        // The backward of logits / T, then of exp: d/d(log T) = T · Σ −g·z/T².
        let sum = 0;
        for (const [index, upstream] of gradient.values.entries())
          sum +=
            (-upstream * (logits.values[index] ?? 0)) /
            (temperature * temperature);
        this.logTemperature.accumulate(
          new Matrix(1, 1, Float64Array.of(sum * temperature)),
        );
      },
    };
  }

  // Venn's fit_temperature (venn/heads/calibration.py): the T for which the
  // softmax of logits / T has the least mean cross-entropy with the targets,
  // by one step of PyTorch's LBFGS with the strong Wolfe line search and at
  // most 100 iterations, from log T = 0.
  static fit(logits: Matrix, targets: ArrayLike<number>): number {
    const scaling = new TemperatureScaling();
    const weights = new Float64Array(logits.rows).fill(1);
    const crossEntropy = new CrossEntropyLoss();
    new LBFGS([scaling.logTemperature], { maxIter: 100 }).step(() => {
      scaling.logTemperature.gradient.values.fill(0);
      const scaled = scaling.forward(logits);
      const { output, pullback } = crossEntropy.forward(
        scaled.output,
        targets,
        weights,
      );
      scaled.accumulate(pullback(1));
      return output;
    });
    return scaling.temperature;
  }
}
