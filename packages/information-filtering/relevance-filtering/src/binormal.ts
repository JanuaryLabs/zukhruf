import { logAddExp, logistic, mean, populationSd, sum } from './statistics.ts';

// The fitted binormal model, on the scores standardised by the mean and the
// standard deviation of the stream.
export type BinormalFit = {
  // The share of relevant articles in the stream.
  readonly share: number;
  readonly relevant: { readonly mean: number; readonly sd: number };
  readonly other: { readonly mean: number; readonly sd: number };
};

const SD_FLOOR = 0.05;
const ITERATIONS = 500;
const TOLERANCE = 1e-9;
const START_SHARE = 0.05;
const LOG_ROOT_TWO_PI = 0.5 * Math.log(2 * Math.PI);

function logNormal(x: number, mu: number, sd: number): number {
  return -0.5 * ((x - mu) / sd) ** 2 - Math.log(sd) - LOG_ROOT_TWO_PI;
}

// A two-normal mixture of the stream's scores, fitted by semi-supervised EM:
// the taught scores stay in their component (docs/adr/0002). Undefined when
// the fit cannot hold: the stream's scores are all equal, or the relevant
// mean is not above the other mean.
export function binormal(
  stream: readonly number[],
  relevant: readonly number[],
  notRelevant: readonly number[],
): { readonly probabilities: number[]; readonly fit: BinormalFit } | undefined {
  const centre = mean(stream);
  const spread = populationSd(stream);
  if (spread === 0) return undefined;
  const standard = (score: number) => (score - centre) / spread;
  const z = stream.map(standard);
  const zp = relevant.map(standard);
  const zn = notRelevant.map(standard);
  const lo = 1 / z.length;
  const hi = 0.5;
  let share = Math.min(Math.max(START_SHARE, lo), hi);
  let mu1 = mean(zp);
  let s1 = Math.max(populationSd(zp), SD_FLOOR);
  let mu0 = mean(z);
  let s0 = Math.max(populationSd(z), SD_FLOOR);
  if (mu1 <= mu0) return undefined;
  const posterior = () =>
    z.map((x) =>
      logistic(
        Math.log(share) +
          logNormal(x, mu1, s1) -
          Math.log(1 - share) -
          logNormal(x, mu0, s0),
      ),
    );
  let previous = -Infinity;
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const r = posterior();
    const logLikelihood =
      sum(
        z.map((x) =>
          logAddExp(
            Math.log(share) + logNormal(x, mu1, s1),
            Math.log(1 - share) + logNormal(x, mu0, s0),
          ),
        ),
      ) +
      sum(zp.map((x) => logNormal(x, mu1, s1))) +
      sum(zn.map((x) => logNormal(x, mu0, s0)));
    if (Math.abs(logLikelihood - previous) < TOLERANCE) break;
    previous = logLikelihood;
    share = Math.min(Math.max(mean(r), lo), hi);
    [mu1, s1] = weighted(z, r, zp);
    [mu0, s0] = weighted(
      z,
      r.map((value) => 1 - value),
      zn,
    );
    if (mu1 <= mu0) return undefined;
  }
  return {
    probabilities: posterior(),
    fit: {
      share,
      relevant: { mean: mu1, sd: s1 },
      other: { mean: mu0, sd: s0 },
    },
  };
}

// The mean and the floored standard deviation of the stream scores with
// their weights and of the taught scores with weight 1, over the joined
// arrays as numpy sums them.
function weighted(
  z: readonly number[],
  weights: readonly number[],
  taught: readonly number[],
): [number, number] {
  const w = [...weights, ...taught.map(() => 1)];
  const x = [...z, ...taught];
  const total = sum(w);
  const centre =
    sum(w.map((weight, index) => weight * (x[index] ?? 0))) / total;
  const variance =
    sum(w.map((weight, index) => weight * ((x[index] ?? 0) - centre) ** 2)) /
    total;
  return [centre, Math.max(Math.sqrt(variance), SD_FLOOR)];
}
