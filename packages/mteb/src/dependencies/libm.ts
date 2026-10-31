// log of the C library, which Python's math.log and numpy's np.log call.
// V8's Math.log (fdlibm) and the C library of macOS round about 1% of
// integers to different floats. This log is the correctly rounded natural
// logarithm: it computes log(x) in double-double arithmetic (about 100 bits)
// and rounds once. Thus it equals any C library whose log rounds correctly
// for x. clustering.golden.test.ts checks it against the log of macOS for the
// integers 1 to 16384.

type DoubleDouble = readonly [hi: number, lo: number];

const SPLITTER = 134_217_729; // 2^27 + 1

function twoSum(a: number, b: number): DoubleDouble {
  const s = a + b;
  const bb = s - a;
  return [s, a - (s - bb) + (b - bb)];
}

function quickTwoSum(a: number, b: number): DoubleDouble {
  const s = a + b;
  return [s, b - (s - a)];
}

function split(a: number): DoubleDouble {
  const t = SPLITTER * a;
  const hi = t - (t - a);
  return [hi, a - hi];
}

function twoProduct(a: number, b: number): DoubleDouble {
  const p = a * b;
  const [aHi, aLo] = split(a);
  const [bHi, bLo] = split(b);
  return [p, aHi * bHi - p + aHi * bLo + aLo * bHi + aLo * bLo];
}

function add([aHi, aLo]: DoubleDouble, [bHi, bLo]: DoubleDouble): DoubleDouble {
  const [s, e] = twoSum(aHi, bHi);
  const [t, f] = twoSum(aLo, bLo);
  const [u, g] = quickTwoSum(s, e + t);
  return quickTwoSum(u, g + f);
}

function multiply(
  [aHi, aLo]: DoubleDouble,
  [bHi, bLo]: DoubleDouble,
): DoubleDouble {
  const [p, e] = twoProduct(aHi, bHi);
  return quickTwoSum(p, e + (aHi * bLo + aLo * bHi));
}

function divide(a: DoubleDouble, b: DoubleDouble): DoubleDouble {
  const q1 = a[0] / b[0];
  let r = add(a, negate(multiply(b, [q1, 0])));
  const q2 = r[0] / b[0];
  r = add(r, negate(multiply(b, [q2, 0])));
  const q3 = r[0] / b[0];
  return add(quickTwoSum(q1, q2), [q3, 0]);
}

function negate([hi, lo]: DoubleDouble): DoubleDouble {
  return [-hi, -lo];
}

// ln 2 to about 107 bits.
const LN2: DoubleDouble = [
  0.693_147_180_559_945_3, 2.319_046_813_846_299_6e-17,
];

// 1 / (2k + 1) as double-doubles, for the series of atanh.
const TERMS = 24;
const RECIPROCALS: readonly DoubleDouble[] = Array.from(
  { length: TERMS },
  (_, k) => divide([1, 0], [2 * k + 1, 0]),
);

const view = new DataView(new ArrayBuffer(8));

// The exponent e and the mantissa m of x = 2^e * m, with m in
// [sqrt(1/2), sqrt(2)).
function frexp(x: number): { exponent: number; mantissa: number } {
  let value = x;
  let bias = 0;
  if (value < 2 ** -1000) {
    value *= 2 ** 64;
    bias = -64;
  }
  view.setFloat64(0, value);
  const high = view.getUint32(0);
  const exponent = ((high >>> 20) & 0x7ff) - 1023;
  view.setUint32(0, (high & 0x800f_ffff) | (1023 << 20));
  let mantissa = view.getFloat64(0);
  let shifted = exponent + bias;
  if (mantissa > Math.SQRT2) {
    mantissa /= 2;
    shifted += 1;
  }
  return { exponent: shifted, mantissa };
}

export function log(x: number): number {
  if (Number.isNaN(x) || x < 0) return Number.NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  if (x === 1) return 0;
  const { exponent, mantissa } = frexp(x);
  // log(m) = 2 atanh(s), s = (m - 1) / (m + 1). m - 1 is exact.
  const s = divide([mantissa - 1, 0], twoSum(mantissa, 1));
  const t = multiply(s, s);
  let series = RECIPROCALS[TERMS - 1] ?? [0, 0];
  for (let k = TERMS - 2; k >= 0; k--)
    series = add(multiply(series, t), RECIPROCALS[k] ?? [0, 0]);
  const logMantissa = multiply(multiply(s, series), [2, 0]);
  const result = add(multiply(LN2, [exponent, 0]), logMantissa);
  return result[0] + result[1];
}
