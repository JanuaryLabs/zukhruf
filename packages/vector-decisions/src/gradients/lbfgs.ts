import type { Parameter } from './parameter.ts';

// The option that Venn sets; the others stay at the defaults of PyTorch.
export type LBFGSOptions = { readonly maxIter: number };

// The loss at the values of the parameters. It leaves the gradient of the
// loss in each parameter, as a closure of PyTorch does with zero_grad and
// backward.
export type Closure = () => number;

const LR = 1;
const TOLERANCE_GRAD = 1e-7;
const TOLERANCE_CHANGE = 1e-9;
const HISTORY_SIZE = 100;
// The sufficient decrease and the curvature of the strong Wolfe conditions.
const C1 = 1e-4;
const C2 = 0.9;

type Point = { readonly loss: number; readonly gradient: Float64Array };

// A step t along the direction, the point there, and the slope of the loss
// along the direction there.
type Trial = {
  readonly t: number;
  readonly point: Point;
  readonly gtd: number;
};

// A step s, the change of the gradient y over it, and 1 / (y · s).
type Correction = {
  readonly y: Float64Array;
  readonly s: Float64Array;
  readonly ro: number;
};

// The gradient, the direction and the step of the iteration before.
type Previous = {
  readonly gradient: Float64Array;
  readonly d: Float64Array;
  readonly t: number;
};

// torch.optim.LBFGS of PyTorch 2.15.0 with line_search_fn="strong_wolfe"
// (torch/optim/lbfgs.py). Venn makes a new optimizer for each fit and calls
// step once, so step keeps no state from one call to the next.
export class LBFGS {
  readonly #parameters: readonly Parameter[];
  readonly #maxIter: number;

  constructor(parameters: readonly Parameter[], { maxIter }: LBFGSOptions) {
    this.#parameters = parameters;
    this.#maxIter = maxIter;
  }

  // Up to maxIter iterations of L-BFGS, each with the strong Wolfe line
  // search of _strong_wolfe, with PyTorch's stops.
  step(closure: Closure): void {
    const maxEval = Math.floor((this.#maxIter * 5) / 4);
    let point = this.#evaluate(closure);
    let evaluations = 1;
    if (maxAbs(point.gradient) <= TOLERANCE_GRAD) return;
    const history: Correction[] = [];
    let hDiag = 1;
    let last: Previous | undefined;
    for (let nIter = 1; nIter <= this.#maxIter; nIter++) {
      const { gradient } = point;
      let d: Float64Array;
      if (last === undefined) d = gradient.map((value) => -value);
      else {
        const previous = last;
        const y = gradient.map(
          (value, index) => value - (previous.gradient[index] ?? 0),
        );
        const s = previous.d.map((value) => value * previous.t);
        const ys = dot(y, s);
        if (ys > 1e-10) {
          if (history.length === HISTORY_SIZE) history.shift();
          history.push({ y, s, ro: 1 / ys });
          hDiag = ys / dot(y, y);
        }
        d = LBFGS.#direction(gradient, history, hDiag);
      }
      const t =
        nIter === 1 ? Math.min(1, 1 / LBFGS.#sumAbs(gradient)) * LR : LR;
      const gtd = dot(gradient, d);
      if (gtd > -TOLERANCE_CHANGE) break;
      const start = this.#values();
      const search = new StrongWolfe(
        (step) => {
          this.#move(start, step, d);
          const at = this.#evaluate(closure);
          this.#move(start, 0, d);
          return at;
        },
        d,
        point,
        gtd,
        maxEval - evaluations,
      );
      const found = search.search(t);
      this.#move(start, found.t, d);
      evaluations += search.evaluations;
      const previousLoss = point.loss;
      point = found.point;
      last = { gradient, d, t: found.t };
      if (nIter === this.#maxIter || evaluations >= maxEval) break;
      if (maxAbs(point.gradient) <= TOLERANCE_GRAD) break;
      if (maxAbs(d) * Math.abs(found.t) <= TOLERANCE_CHANGE) break;
      if (Math.abs(point.loss - previousLoss) < TOLERANCE_CHANGE) break;
    }
  }

  #evaluate(closure: Closure): Point {
    const loss = closure();
    return {
      loss,
      gradient: LBFGS.#flat(this.#parameters.map((p) => p.gradient.values)),
    };
  }

  #values(): Float64Array {
    return LBFGS.#flat(this.#parameters.map((p) => p.value.values));
  }

  // torch's _add_grad and _set_param (torch/optim/lbfgs.py).
  #move(start: Float64Array, step: number, d: Float64Array): void {
    let offset = 0;
    for (const { value } of this.#parameters) {
      for (let i = 0; i < value.values.length; i++)
        value.values[i] =
          (start[offset + i] ?? 0) + step * (d[offset + i] ?? 0);
      offset += value.values.length;
    }
  }

  // The two-loop recursion of L-BFGS: the direction −H·g of the history of
  // corrections.
  static #direction(
    gradient: Float64Array,
    history: readonly Correction[],
    hDiag: number,
  ): Float64Array {
    const al = new Float64Array(history.length);
    const q = gradient.map((value) => -value);
    for (const [i, { y, s, ro }] of history.entries().toArray().reverse()) {
      const alpha = dot(s, q) * ro;
      al[i] = alpha;
      LBFGS.#addScaled(q, y, -alpha);
    }
    const r = q.map((value) => value * hDiag);
    for (const [i, { y, s, ro }] of history.entries())
      LBFGS.#addScaled(r, s, (al[i] ?? 0) - dot(y, r) * ro);
    return r;
  }

  static #flat(parts: readonly Float64Array[]): Float64Array {
    const all = new Float64Array(parts.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      all.set(part, offset);
      offset += part.length;
    }
    return all;
  }

  static #addScaled(
    target: Float64Array,
    other: Float64Array,
    alpha: number,
  ): void {
    for (const [i, value] of other.entries())
      target[i] = (target[i] ?? 0) + alpha * value;
  }

  static #sumAbs(values: Float64Array): number {
    return values.reduce((sum, value) => sum + Math.abs(value), 0);
  }
}

// _strong_wolfe of PyTorch: a step along d that meets the strong Wolfe
// conditions, found by cubic interpolation, as Nocedal and Wright, Numerical
// Optimization, Algorithms 3.5 (bracketing) and 3.6 (zoom). One object is one
// search.
class StrongWolfe {
  readonly #at: (step: number) => Point;
  readonly #d: Float64Array;
  readonly #dNorm: number;
  readonly #start: Trial;
  readonly #maxLs: number;
  #evaluations = 0;
  #lsIter = 0;
  // During bracketing, the previous and the current trial; during zoom, the
  // ends of the interval that holds a step that meets the conditions.
  #bracket: [Trial, Trial];
  #low: 0 | 1 = 0;
  #high: 0 | 1 = 1;

  constructor(
    at: (step: number) => Point,
    d: Float64Array,
    start: Point,
    gtd: number,
    maxLs: number,
  ) {
    this.#at = at;
    this.#d = d;
    this.#dNorm = maxAbs(d);
    this.#start = { t: 0, point: start, gtd };
    this.#maxLs = maxLs;
    this.#bracket = [this.#start, this.#start];
  }

  get evaluations(): number {
    return this.#evaluations;
  }

  search(initialStep: number): Trial {
    return this.#bracketing(initialStep) ?? this.#zoom();
  }

  // The trial that meets both conditions, if bracketing finds one; otherwise
  // it leaves the interval that zoom narrows in the bracket.
  #bracketing(initialStep: number): Trial | undefined {
    this.#bracket = [this.#start, this.#trial(initialStep)];
    while (this.#lsIter < this.#maxLs) {
      const [previous, current] = this.#bracket;
      if (
        this.#sufficientDecreaseFails(current) ||
        (this.#lsIter > 1 && current.point.loss >= previous.point.loss)
      )
        return;
      if (this.#curvatureHolds(current)) return current;
      if (current.gtd >= 0) return;
      const t = StrongWolfe.#cubicInterpolate(previous, current, [
        current.t + 0.01 * (current.t - previous.t),
        current.t * 10,
      ]);
      this.#bracket = [current, this.#trial(t)];
      this.#lsIter += 1;
    }
    this.#bracket = [this.#start, this.#bracket[1]];
  }

  #zoom(): Trial {
    this.#order();
    let insufficientProgress = false;
    while (this.#lsIter < this.#maxLs) {
      const [a, b] = this.#bracket;
      if (Math.abs(b.t - a.t) * this.#dNorm < TOLERANCE_CHANGE) break;
      const [t, stalled] = StrongWolfe.#safeguard(
        StrongWolfe.#cubicInterpolate(a, b),
        a.t,
        b.t,
        insufficientProgress,
      );
      insufficientProgress = stalled;
      const next = this.#trial(t);
      this.#lsIter += 1;
      const low = this.#bracket[this.#low];
      const high = this.#bracket[this.#high];
      if (
        this.#sufficientDecreaseFails(next) ||
        next.point.loss >= low.point.loss
      ) {
        this.#bracket[this.#high] = next;
        this.#order();
      } else {
        if (this.#curvatureHolds(next)) return next;
        if (next.gtd * (high.t - low.t) >= 0) this.#bracket[this.#high] = low;
        this.#bracket[this.#low] = next;
      }
    }
    return this.#bracket[this.#low];
  }

  // A step within 10% of the width of the bracket from an end moves to 10%
  // inside it when the step before was also that close, or when it is at or
  // past the end; otherwise the next step learns that this one was close.
  static #safeguard(
    t: number,
    a: number,
    b: number,
    insufficientProgress: boolean,
  ): readonly [t: number, insufficientProgress: boolean] {
    const largest = Math.max(a, b);
    const smallest = Math.min(a, b);
    const eps = 0.1 * (largest - smallest);
    if (!(Math.min(largest - t, t - smallest) < eps)) return [t, false];
    if (insufficientProgress || t >= largest || t <= smallest)
      return [
        Math.abs(t - largest) < Math.abs(t - smallest)
          ? largest - eps
          : smallest + eps,
        false,
      ];
    return [t, true];
  }

  #trial(t: number): Trial {
    const point = this.#at(t);
    this.#evaluations += 1;
    return { t, point, gtd: dot(point.gradient, this.#d) };
  }

  #sufficientDecreaseFails({ t, point }: Trial): boolean {
    return point.loss > this.#start.point.loss + C1 * t * this.#start.gtd;
  }

  #curvatureHolds({ gtd }: Trial): boolean {
    return Math.abs(gtd) <= -C2 * this.#start.gtd;
  }

  // The positions of the lower and the higher loss in the bracket.
  #order(): void {
    const [a, b] = this.#bracket;
    [this.#low, this.#high] = a.point.loss <= b.point.loss ? [0, 1] : [1, 0];
  }

  // _cubic_interpolate: the minimizer of the cubic through two points with
  // their slopes, in the bounds, or the middle of the bounds when the cubic has
  // no minimizer.
  static #cubicInterpolate(
    { t: x1, point: { loss: f1 }, gtd: g1 }: Trial,
    { t: x2, point: { loss: f2 }, gtd: g2 }: Trial,
    [xMin, xMax]: readonly [number, number] = x1 <= x2 ? [x1, x2] : [x2, x1],
  ): number {
    const d1 = g1 + g2 - (3 * (f1 - f2)) / (x1 - x2);
    const d2Square = d1 ** 2 - g1 * g2;
    if (d2Square < 0) return (xMin + xMax) / 2;
    const d2 = Math.sqrt(d2Square);
    const minimizer =
      x1 <= x2
        ? x2 - (x2 - x1) * ((g2 + d2 - d1) / (g2 - g1 + 2 * d2))
        : x1 - (x1 - x2) * ((g1 + d2 - d1) / (g1 - g2 + 2 * d2));
    return Math.min(Math.max(minimizer, xMin), xMax);
  }
}

function dot(a: Float64Array, b: Float64Array): number {
  let total = 0;
  for (const [i, value] of a.entries()) total += value * (b[i] ?? 0);
  return total;
}

function maxAbs(values: Float64Array): number {
  return values.reduce(
    (largest, value) => Math.max(largest, Math.abs(value)),
    0,
  );
}
