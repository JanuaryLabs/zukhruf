import { logAddExp, mean, sum } from './statistics.ts';

// The calibration when the binormal fit cannot hold. With Platt's form,
// p = 1 / (1 + exp(a * score + b)), so a relevant article needs a < 0.
export type PlattFit =
  | { readonly method: 'platt'; readonly a: number; readonly b: number }
  // The taught scores do not rank the relevant answers above the others
  // (AUC <= 0.5), so the score says nothing: each article gets the mean
  // smoothed target of the taught answers.
  | { readonly method: 'constant'; readonly probability: number };

// Platt (1999) on the taught scores, with smoothed targets, by Newton steps
// with a line search (Lin, Lin and Weng 2007).
export function platt(
  relevant: readonly number[],
  notRelevant: readonly number[],
): PlattFit {
  const relevantTarget = (relevant.length + 1) / (relevant.length + 2);
  const otherTarget = 1 / (notRelevant.length + 2);
  if (auc(relevant, notRelevant) <= 0.5)
    return {
      method: 'constant',
      probability: mean([
        ...relevant.map(() => relevantTarget),
        ...notRelevant.map(() => otherTarget),
      ]),
    };
  const scores = [...relevant, ...notRelevant];
  const targets = [
    ...relevant.map(() => relevantTarget),
    ...notRelevant.map(() => otherTarget),
  ];
  const loss = (a: number, b: number) =>
    sum(
      scores.map((score, index) => {
        const z = a * score + b;
        const t = targets[index] ?? 0;
        return t * logAddExp(0, z) + (1 - t) * logAddExp(0, -z);
      }),
    );
  let a = 0;
  let b = Math.log((notRelevant.length + 1) / (relevant.length + 1));
  let current = loss(a, b);
  for (let iteration = 0; iteration < 1000; iteration++) {
    const p = scores.map((score) => 1 / (1 + Math.exp(a * score + b)));
    const d1 = p.map((value, index) => (targets[index] ?? 0) - value);
    const gA = sum(d1.map((value, index) => value * (scores[index] ?? 0)));
    const gB = sum(d1);
    if (Math.hypot(gA, gB) < 1e-12) break;
    const h = p.map((value) => value * (1 - value) + 1e-12);
    const hAA =
      sum(
        h.map(
          (value, index) => value * (scores[index] ?? 0) * (scores[index] ?? 0),
        ),
      ) + 1e-12;
    const hAB = sum(h.map((value, index) => value * (scores[index] ?? 0)));
    const hBB = sum(h) + 1e-12;
    const [dA, dB] = solve(hAA, hAB, hBB, -gA, -gB);
    let step = 1;
    let next = { a, b, loss: current };
    while (step > 1e-12) {
      next = { a: a + step * dA, b: b + step * dB, loss: 0 };
      next.loss = loss(next.a, next.b);
      if (next.loss < current + 1e-4 * step * (gA * dA + gB * dB)) break;
      step /= 2;
    }
    if (step <= 1e-12) break;
    ({ a, b, loss: current } = next);
  }
  return { method: 'platt', a, b };
}

export function plattProbability(fit: PlattFit, score: number): number {
  return fit.method === 'constant'
    ? fit.probability
    : 1 / (1 + Math.exp(fit.a * score + fit.b));
}

// The probability that a relevant answer scores above a not-relevant one,
// with ties as one half.
function auc(relevant: readonly number[], notRelevant: readonly number[]) {
  const pairs = relevant.flatMap((u) =>
    notRelevant.map((v) => (u > v ? 1 : u === v ? 0.5 : 0)),
  );
  return mean(pairs);
}

// The solution of [[a, b], [b, c]] x = [r1, r2], by LU with partial
// pivoting, as numpy.linalg.solve (LAPACK dgesv) finds it.
function solve(
  a: number,
  b: number,
  c: number,
  r1: number,
  r2: number,
): [number, number] {
  if (Math.abs(b) > Math.abs(a)) {
    const factor = a / b;
    const x2 = (r1 - factor * r2) / (b - factor * c);
    return [(r2 - c * x2) / b, x2];
  }
  const factor = b / a;
  const x2 = (r2 - factor * r1) / (c - factor * b);
  return [(r1 - b * x2) / a, x2];
}
