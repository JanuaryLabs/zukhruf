import { ddot } from './blas.ts';

// scipy.optimize.minimize(method="L-BFGS-B") of SciPy 1.18.1 with jac=True:
// the driver of scipy/optimize/_lbfgsb_py.py and the C port of the Fortran
// L-BFGS-B 3.0 in scipy/optimize/src/lbfgsb.c (Byrd, Lu, Nocedal and Zhu),
// with its line search dcsrch and dcstep of MINPACK-2. The C code returns
// to the driver for each evaluation of f and g (reverse communication);
// this port calls the function in place. The arrays keep the indices of
// the C code: column j of an n x m matrix starts at n * j.
//
// SciPy calls BLAS (ddot, dnrm2, dscal, daxpy, dcopy) and LAPACK (dpotrf,
// dtrtrs) of the platform. This port adds a dot product in index order and
// solves the triangular and Cholesky systems as the reference LAPACK does
// without blocks. Accelerate adds in another order, so x can differ from
// SciPy's in the last bits, and the counts can differ when a test falls
// on its threshold.

// The function and its gradient at x.
export type FunctionAndGradient = (
  x: Float64Array,
) => readonly [f: number, g: ArrayLike<number>];

// A bound of one variable: -Infinity or Infinity when it has none.
export type Bound = readonly [lower: number, upper: number];

export type LbfgsbOptions = {
  // maxcor: the number of corrections that the limited memory matrix keeps.
  readonly maxcor?: number;
  readonly ftol?: number;
  readonly gtol?: number;
  readonly maxfun?: number;
  readonly maxiter?: number;
  readonly maxls?: number;
  readonly bounds?: readonly Bound[];
};

export type LbfgsbResult = {
  readonly x: Float64Array;
  readonly fun: number;
  readonly jac: Float64Array;
  readonly nfev: number;
  readonly nit: number;
  // 0: converged; 1: maxfun or maxiter reached; 2: stopped for another
  // reason.
  readonly status: 0 | 1 | 2;
  readonly message: string;
  readonly success: boolean;
};

const Task = {
  START: 0,
  NEW_X: 1,
  RESTART: 2,
  FG: 3,
  CONVERGENCE: 4,
  STOP: 5,
  WARNING: 6,
  ERROR: 7,
  ABNORMAL: 8,
} as const;

type Status = (typeof Task)[keyof typeof Task];

const STATUS_MESSAGES: Readonly<Record<Status, string>> = {
  [Task.START]: 'START',
  [Task.NEW_X]: 'NEW_X',
  [Task.RESTART]: 'RESTART',
  [Task.FG]: 'FG',
  [Task.CONVERGENCE]: 'CONVERGENCE',
  [Task.STOP]: 'STOP',
  [Task.WARNING]: 'WARNING',
  [Task.ERROR]: 'ERROR',
  [Task.ABNORMAL]: 'ABNORMAL',
};

const TASK_MESSAGES: Readonly<Record<number, string>> = {
  0: '',
  301: '',
  302: '',
  401: 'NORM OF PROJECTED GRADIENT <= PGTOL',
  402: 'RELATIVE REDUCTION OF F <= FACTR*EPSMCH',
  502: 'TOTAL NO. OF F,G EVALUATIONS EXCEEDS LIMIT',
  504: 'TOTAL NO. OF ITERATIONS REACHED LIMIT',
  601: 'ROUNDING ERRORS PREVENT PROGRESS',
  602: 'STP = STPMAX',
  603: 'STP = STPMIN',
  604: 'XTOL TEST SATISFIED',
  701: 'NO FEASIBLE SOLUTION',
  702: 'FACTR < 0',
  703: 'FTOL < 0',
  704: 'GTOL < 0',
  705: 'XTOL < 0',
  706: 'STP < STPMIN',
  707: 'STP > STPMAX',
  708: 'STPMIN < 0',
  709: 'STPMAX < STPMIN',
  710: 'INITIAL G >= 0',
  711: 'M <= 0',
  712: 'N <= 0',
  713: 'INVALID NBD',
};

const NO_MSG = 0;
const FG_START = 301;
const FG_LNSRCH = 302;
const CONV_GRAD = 401;
const CONV_F = 402;
const STOP_ITER = 502;
const STOP_ITERC = 504;
const WARN_ROUND = 601;
const WARN_STPMAX = 602;
const WARN_STPMIN = 603;
const WARN_XTOL = 604;
const ERROR_NOFEAS = 701;
const ERROR_FACTR = 702;
const ERROR_FTOL = 703;
const ERROR_GTOL = 704;
const ERROR_XTOL = 705;
const ERROR_STP1 = 706;
const ERROR_STP2 = 707;
const ERROR_STPMIN = 708;
const ERROR_STPMAX = 709;
const ERROR_INITG = 710;
const ERROR_M = 711;
const ERROR_N = 712;
const ERROR_NBD = 713;

const EPSMACH = 2.220446049250313e-16;

// _minimize_lbfgsb with its defaults.
export function minimizeLbfgsb(
  fun: FunctionAndGradient,
  x0: ArrayLike<number>,
  options: LbfgsbOptions = {},
): LbfgsbResult {
  const m = options.maxcor ?? 10;
  const pgtol = options.gtol ?? 1e-5;
  const factr = (options.ftol ?? 2.220446049250313e-9) / EPSMACH;
  const maxfun = options.maxfun ?? 15_000;
  const maxiter = options.maxiter ?? 15_000;
  const maxls = options.maxls ?? 20;
  const n = x0.length;
  const l = new Float64Array(n);
  const u = new Float64Array(n);
  const nbd = new Int32Array(n);
  let x = Float64Array.from(x0);
  const { bounds } = options;
  if (bounds !== undefined) {
    if (bounds.length !== n)
      throw new Error('length of x0 != length of bounds');
    if (bounds.some(([lower, upper]) => lower > upper))
      throw new Error(
        'LBFGSB - one of the lower bounds is greater than an upper bound.',
      );
    for (const [i, [lower, upper]] of bounds.entries()) {
      x[i] = Math.min(Math.max(x[i] ?? 0, lower), upper);
      const hasLower = lower !== -Infinity;
      const hasUpper = upper !== Infinity;
      if (hasLower) l[i] = lower;
      if (hasUpper) u[i] = upper;
      nbd[i] = hasLower ? (hasUpper ? 2 : 1) : hasUpper ? 3 : 0;
    }
  }
  if (!(maxls > 0)) throw new Error('maxls must be positive.');
  const evaluation = new ScalarFunction(fun, x);
  x = Float64Array.from(evaluation.x);
  let nIterations = 0;
  const solver = new Lbfgsb(n, m, l, u, nbd, factr, pgtol, maxls);
  const { task, taskMsg, f, g } = solver.run(
    x,
    (point) => evaluation.funAndGrad(point),
    () => {
      nIterations += 1;
      if (nIterations >= maxiter) return STOP_ITERC;
      if (evaluation.nfev > maxfun) return STOP_ITER;
      return null;
    },
  );
  let status: 0 | 1 | 2;
  if (task === Task.CONVERGENCE) status = 0;
  else if (evaluation.nfev > maxfun || nIterations >= maxiter) status = 1;
  else status = 2;
  return {
    x,
    fun: f,
    jac: g,
    nfev: evaluation.nfev,
    nit: nIterations,
    status,
    message: `${STATUS_MESSAGES[task]}: ${TASK_MESSAGES[taskMsg] ?? ''}`,
    success: status === 0,
  };
}

// scipy.optimize._differentiable_functions.ScalarFunction with jac=True: it
// evaluates x0 once when it starts, and again only for an x that differs
// from the last one.
class ScalarFunction {
  x: Float64Array;
  nfev = 0;
  #f: number;
  #g: Float64Array;
  readonly #fun: FunctionAndGradient;

  constructor(fun: FunctionAndGradient, x0: Float64Array) {
    this.#fun = fun;
    this.x = Float64Array.from(x0);
    [this.#f, this.#g] = this.#evaluate();
  }

  funAndGrad(x: Float64Array): readonly [number, Float64Array] {
    if (!arrayEqual(x, this.x)) {
      this.x = Float64Array.from(x);
      [this.#f, this.#g] = this.#evaluate();
    }
    return [this.#f, Float64Array.from(this.#g)];
  }

  #evaluate(): [number, Float64Array] {
    const [f, g] = this.#fun(Float64Array.from(this.x));
    this.nfev += 1;
    return [f, Float64Array.from(g)];
  }
}

function arrayEqual(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// The line search state that dcsrch keeps between its calls.
type LineSearch = {
  task: Status;
  taskMsg: number;
  brackt: boolean;
  stage: number;
  ginit: number;
  gtest: number;
  gx: number;
  gy: number;
  finit: number;
  fx: number;
  fy: number;
  stx: number;
  sty: number;
  stmin: number;
  stmax: number;
  width: number;
  width1: number;
};

// mainlb and its subroutines, over the working arrays of setulb.
class Lbfgsb {
  readonly n: number;
  readonly m: number;
  readonly l: Float64Array;
  readonly u: Float64Array;
  readonly nbd: Int32Array;
  readonly factr: number;
  readonly pgtol: number;
  readonly maxls: number;
  readonly ws: Float64Array;
  readonly wy: Float64Array;
  readonly sy: Float64Array;
  readonly ss: Float64Array;
  readonly wt: Float64Array;
  readonly wn: Float64Array;
  readonly snd: Float64Array;
  readonly z: Float64Array;
  readonly r: Float64Array;
  readonly d: Float64Array;
  readonly t: Float64Array;
  readonly xp: Float64Array;
  readonly wa: Float64Array;
  readonly index: Int32Array;
  readonly iwhere: Int32Array;
  readonly indx2: Int32Array;

  constructor(
    n: number,
    m: number,
    l: Float64Array,
    u: Float64Array,
    nbd: Int32Array,
    factr: number,
    pgtol: number,
    maxls: number,
  ) {
    this.n = n;
    this.m = m;
    this.l = l;
    this.u = u;
    this.nbd = nbd;
    this.factr = factr;
    this.pgtol = pgtol;
    this.maxls = maxls;
    this.ws = new Float64Array(m * n);
    this.wy = new Float64Array(m * n);
    this.sy = new Float64Array(m * m);
    this.ss = new Float64Array(m * m);
    this.wt = new Float64Array(m * m);
    this.wn = new Float64Array(4 * m * m);
    this.snd = new Float64Array(4 * m * m);
    this.z = new Float64Array(n);
    this.r = new Float64Array(n);
    this.d = new Float64Array(n);
    this.t = new Float64Array(n);
    this.xp = new Float64Array(n);
    this.wa = new Float64Array(8 * m);
    this.index = new Int32Array(n);
    this.iwhere = new Int32Array(n);
    this.indx2 = new Int32Array(n);
  }

  // mainlb from START to the end of the run. evaluate gives f and g at x;
  // newX is the driver after each iteration: a message to stop, or null.
  run(
    x: Float64Array,
    evaluate: (x: Float64Array) => readonly [number, Float64Array],
    newX: () => number | null,
  ): { task: Status; taskMsg: number; f: number; g: Float64Array } {
    const { n, l, u, nbd, z, r, d, t } = this;
    let f = 0;
    let g: Float64Array = new Float64Array(n);

    let col = 0;
    let head = 0;
    let theta = 1;
    let iupdat = 0;
    let updatd = false;
    let iback = 0;
    let itail = 0;
    let ileave = 0;
    let nenter = 0;
    let fold = 0;
    let gd: number;
    let stp = 0;
    let gdold = 0;
    let dtd = 0;
    let stpmx = 0;
    let iter = 0;
    let nfree = n;
    let ifun = 0;
    const tol = this.factr * EPSMACH;
    let info = 0;
    let wrk: boolean;

    const error = this.errclb(this.factr);
    if (error !== null) return { task: Task.ERROR, taskMsg: error, f, g };
    const { cnstnd, boxed } = this.active(x);

    let task: Status = Task.FG;
    let taskMsg = FG_START;
    [f, g] = evaluate(x);
    let sbgnrm = this.projgr(x, g);
    if (sbgnrm <= this.pgtol)
      return { task: Task.CONVERGENCE, taskMsg: CONV_GRAD, f, g };

    const lineSearch: LineSearch = {
      task: Task.START,
      taskMsg: NO_MSG,
      brackt: false,
      stage: 0,
      ginit: 0,
      gtest: 0,
      gx: 0,
      gy: 0,
      finit: 0,
      fx: 0,
      fy: 0,
      stx: 0,
      sty: 0,
      stmin: 0,
      stmax: 0,
      width: 0,
      width1: 0,
    };

    const refresh = () => {
      info = 0;
      col = 0;
      head = 0;
      theta = 1;
      iupdat = 0;
      updatd = false;
    };

    for (;;) {
      if (cnstnd || col === 0) {
        info = this.cauchy(x, g, theta, col, head, sbgnrm);
        if (info !== 0) {
          refresh();
          continue;
        }
        const free = this.freev(nfree, updatd, cnstnd, iter);
        nfree = free.nfree;
        nenter = free.nenter;
        ileave = free.ileave;
        wrk = free.wrk;
      } else {
        z.set(x);
        wrk = updatd;
      }

      if (nfree !== 0 && col !== 0) {
        if (wrk)
          info = this.formk(
            nfree,
            nenter,
            ileave,
            iupdat,
            updatd,
            theta,
            col,
            head,
          );
        if (info !== 0) {
          refresh();
          continue;
        }
        info = this.cmprlb(x, g, theta, col, head, nfree, cnstnd);
        if (info === 0) info = this.subsm(nfree, x, g, theta, col, head);
        if (info !== 0) {
          refresh();
          continue;
        }
      }

      for (let i = 0; i < n; i++) d[i] = (z[i] ?? 0) - (x[i] ?? 0);

      let restart = false;
      for (;;) {
        // lnsrlb
        if (taskMsg !== FG_LNSRCH) {
          const dnorm = dnrm2(n, d);
          dtd = dnorm ** 2;
          stpmx = 1e10;
          if (cnstnd) {
            if (iter === 0) stpmx = 1;
            else
              for (let i = 0; i < n; i++) {
                const a1 = d[i] ?? 0;
                if ((nbd[i] ?? 0) === 0) continue;
                if (a1 < 0 && (nbd[i] ?? 0) <= 2) {
                  const a2 = (l[i] ?? 0) - (x[i] ?? 0);
                  if (a2 >= 0) stpmx = 0;
                  else if (a1 * stpmx < a2) stpmx = a2 / a1;
                } else if (a1 > 0 && (nbd[i] ?? 0) >= 2) {
                  const a2 = (u[i] ?? 0) - (x[i] ?? 0);
                  if (a2 <= 0) stpmx = 0;
                  else if (a1 * stpmx > a2) stpmx = a2 / a1;
                }
              }
          }
          stp = iter === 0 && !boxed ? Math.min(1 / dnorm, stpmx) : 1;
          t.set(x);
          r.set(g);
          fold = f;
          ifun = 0;
          iback = 0;
          lineSearch.task = Task.START;
          lineSearch.taskMsg = NO_MSG;
        }
        gd = ddot(n, g, 0, d, 0);
        let searchInfo = 0;
        if (ifun === 0) {
          gdold = gd;
          if (gd >= 0) searchInfo = -4;
        }
        if (searchInfo === 0) {
          stp = dcsrch(f, gd, stp, 1e-3, 0.9, 0.1, 0, stpmx, lineSearch);
          if (
            lineSearch.task !== Task.CONVERGENCE &&
            lineSearch.task !== Task.WARNING
          ) {
            task = Task.FG;
            taskMsg = FG_LNSRCH;
            ifun += 1;
            iback = ifun - 1;
            if (stp === 1) x.set(z);
            else
              for (let i = 0; i < n; i++) {
                let value = stp * (d[i] ?? 0) + (t[i] ?? 0);
                const bound = nbd[i] ?? 0;
                if (bound === 1 || bound === 2)
                  value = Math.max(value, l[i] ?? 0);
                if (bound === 2 || bound === 3)
                  value = Math.min(value, u[i] ?? 0);
                x[i] = value;
              }
          } else {
            task = Task.NEW_X;
            taskMsg = NO_MSG;
          }
        }
        info = searchInfo;

        if (info !== 0 || iback >= this.maxls) {
          x.set(t);
          g = Float64Array.from(r);
          f = fold;
          if (col === 0) return { task: Task.ABNORMAL, taskMsg: NO_MSG, f, g };
          refresh();
          task = Task.RESTART;
          taskMsg = NO_MSG;
          restart = true;
          break;
        }
        if (task === Task.FG && taskMsg === FG_LNSRCH) {
          [f, g] = evaluate(x);
          continue;
        }
        iter += 1;
        sbgnrm = this.projgr(x, g);
        const stop = newX();
        if (stop !== null) return { task: Task.STOP, taskMsg: stop, f, g };
        break;
      }
      if (restart) continue;

      // LINE777: the tests for termination.
      if (sbgnrm <= this.pgtol)
        return { task: Task.CONVERGENCE, taskMsg: CONV_GRAD, f, g };
      const ddum = Math.max(Math.abs(fold), Math.abs(f), 1);
      if (fold - f <= tol * ddum)
        return { task: Task.CONVERGENCE, taskMsg: CONV_F, f, g };

      for (let i = 0; i < n; i++) r[i] = (g[i] ?? 0) - (r[i] ?? 0);
      const rr = dnrm2(n, r) ** 2;
      let dr: number;
      let skipBound: number;
      if (stp === 1) {
        dr = gd - gdold;
        skipBound = -gdold;
      } else {
        dr = (gd - gdold) * stp;
        for (let i = 0; i < n; i++) d[i] = stp * (d[i] ?? 0);
        skipBound = -gdold * stp;
      }
      if (dr <= EPSMACH * skipBound) {
        updatd = false;
        continue;
      }

      updatd = true;
      iupdat += 1;
      const update = this.matupd(itail, iupdat, col, head, rr, dr, stp, dtd);
      itail = update.itail;
      col = update.col;
      head = update.head;
      theta = update.theta;
      info = this.formt(col, theta);
      if (info !== 0) refresh();
    }
  }

  // errclb: the message of an error in the arguments, or null.
  errclb(factr: number): number | null {
    const { n, m, l, u, nbd } = this;
    let message: number | null = null;
    if (n <= 0) message = ERROR_N;
    if (m <= 0) message = ERROR_M;
    if (factr < 0) message = ERROR_FACTR;
    for (let i = 0; i < n; i++) {
      const bound = nbd[i] ?? 0;
      if (bound < 0 || bound > 3) message = ERROR_NBD;
      if (bound === 2 && (l[i] ?? 0) > (u[i] ?? 0)) message = ERROR_NOFEAS;
    }
    return message;
  }

  // active: projects x on the bounds and sets iwhere.
  active(x: Float64Array): { cnstnd: boolean; boxed: boolean } {
    const { n, l, u, nbd, iwhere } = this;
    let cnstnd = false;
    let boxed = true;
    for (let i = 0; i < n; i++) {
      const bound = nbd[i] ?? 0;
      if (bound > 0) {
        if (bound <= 2 && (x[i] ?? 0) <= (l[i] ?? 0)) {
          if ((x[i] ?? 0) < (l[i] ?? 0)) x[i] = l[i] ?? 0;
        } else if (bound >= 2 && (x[i] ?? 0) >= (u[i] ?? 0)) {
          if ((x[i] ?? 0) > (u[i] ?? 0)) x[i] = u[i] ?? 0;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const bound = nbd[i] ?? 0;
      if (bound !== 2) boxed = false;
      if (bound === 0) iwhere[i] = -1;
      else {
        cnstnd = true;
        iwhere[i] = bound === 2 && (u[i] ?? 0) - (l[i] ?? 0) <= 0 ? 3 : 0;
      }
    }
    return { cnstnd, boxed };
  }

  // bmv: p = M v for the middle matrix M of the compact L-BFGS formula.
  bmv(col: number, v: Float64Array, p: Float64Array): number {
    const { m, sy, wt } = this;
    if (col === 0) return 0;
    p[col] = v[col] ?? 0;
    for (let i = 1; i < col; i++) {
      const i2 = col + i;
      let ssum = 0;
      for (let k = 0; k <= i - 1; k++)
        ssum += ((sy[i + m * k] ?? 0) * (v[k] ?? 0)) / (sy[k + m * k] ?? 0);
      p[i2] = (v[i2] ?? 0) + ssum;
    }
    let info = dtrtrs(true, col, 1, wt, 0, m, p, col, col);
    if (info !== 0) return info;
    for (let i = 0; i < col; i++)
      p[i] = (v[i] ?? 0) / Math.sqrt(sy[i + m * i] ?? 0);
    info = dtrtrs(false, col, 1, wt, 0, m, p, col, col);
    if (info !== 0) return info;
    for (let i = 0; i < col; i++)
      p[i] = -(p[i] ?? 0) / Math.sqrt(sy[i + m * i] ?? 0);
    for (let i = 0; i < col; i++) {
      let ssum = 0;
      for (let k = i + 1; k < col; k++)
        ssum +=
          ((sy[k + m * i] ?? 0) * (p[col + k] ?? 0)) / (sy[i + m * i] ?? 0);
      p[i] = (p[i] ?? 0) + ssum;
    }
    return 0;
  }

  // cauchy: the generalized Cauchy point xcp (in z), and c = W'(xcp - x)
  // in wa[2m:4m].
  cauchy(
    x: Float64Array,
    g: Float64Array,
    theta: number,
    col: number,
    head: number,
    sbgnrm: number,
  ): number {
    const { n, m, l, u, nbd, wy, ws, iwhere } = this;
    const iorder = this.indx2;
    const t = this.t;
    const d = this.d;
    const xcp = this.z;
    const p = this.wa.subarray(0, 2 * m);
    const c = this.wa.subarray(2 * m, 4 * m);
    const wbp = this.wa.subarray(4 * m, 6 * m);
    const v = this.wa.subarray(6 * m, 8 * m);
    let f1 = 0;
    let tl = 0;
    let tu = 0;
    if (sbgnrm <= 0) {
      xcp.set(x);
      return 0;
    }
    let bnded = true;
    let nfree = n;
    let nbreak = -1;
    let ibkmin = 0;
    let bkmin = 0;
    const col2 = 2 * col;
    for (let i = 0; i < col2; i++) p[i] = 0;
    for (let i = 0; i < n; i++) {
      const neggi = -(g[i] ?? 0);
      const bound = nbd[i] ?? 0;
      if (iwhere[i] !== 3 && iwhere[i] !== -1) {
        if (bound <= 2) tl = (x[i] ?? 0) - (l[i] ?? 0);
        if (bound >= 2) tu = (u[i] ?? 0) - (x[i] ?? 0);
        const xlower = bound <= 2 && tl <= 0;
        const xupper = bound >= 2 && tu <= 0;
        iwhere[i] = 0;
        if (xlower) {
          if (neggi <= 0) iwhere[i] = 1;
        } else if (xupper) {
          if (neggi >= 0) iwhere[i] = 2;
        } else if (Math.abs(neggi) <= 0) iwhere[i] = -3;
      }
      let pointr = head;
      if (iwhere[i] !== 0 && iwhere[i] !== -1) d[i] = 0;
      else {
        d[i] = neggi;
        f1 -= neggi * neggi;
        for (let j = 0; j < col; j++) {
          p[j] = (p[j] ?? 0) + (wy[i + n * pointr] ?? 0) * neggi;
          p[col + j] = (p[col + j] ?? 0) + (ws[i + n * pointr] ?? 0) * neggi;
          pointr = (pointr + 1) % m;
        }
        if (bound <= 2 && bound !== 0 && neggi < 0) {
          nbreak += 1;
          iorder[nbreak] = i;
          t[nbreak] = tl / -neggi;
          if (nbreak === 0 || (t[nbreak] ?? 0) < bkmin) {
            bkmin = t[nbreak] ?? 0;
            ibkmin = nbreak;
          }
        } else if (bound >= 2 && neggi > 0) {
          nbreak += 1;
          iorder[nbreak] = i;
          t[nbreak] = tu / neggi;
          if (nbreak === 0 || (t[nbreak] ?? 0) < bkmin) {
            bkmin = t[nbreak] ?? 0;
            ibkmin = nbreak;
          }
        } else {
          nfree -= 1;
          iorder[nfree] = i;
          if (Math.abs(neggi) > 0) bnded = false;
        }
      }
    }
    if (theta !== 1)
      for (let j = 0; j < col; j++) p[col + j] = theta * (p[col + j] ?? 0);
    xcp.set(x);
    if (nbreak === -1 && nfree === n) return 0;
    for (let j = 0; j < col2; j++) c[j] = 0;
    let f2 = -theta * f1;
    const f2Org = f2;
    if (col > 0) {
      const info = this.bmv(col, p, v);
      if (info !== 0) return info;
      f2 -= ddot(col2, v, 0, p, 0);
    }
    let dtm = -f1 / f2;
    let tsum = 0;
    let nleft = nbreak;
    let iter = 0;
    let tj = 0;
    while (nbreak > -1) {
      const tj0 = tj;
      let ibp: number;
      if (iter === 0) {
        tj = bkmin;
        ibp = iorder[ibkmin] ?? 0;
      } else {
        if (iter === 1 && ibkmin !== nbreak) {
          t[ibkmin] = t[nbreak] ?? 0;
          iorder[ibkmin] = iorder[nbreak] ?? 0;
        }
        hpsolb(nleft, t, iorder, iter - 1);
        tj = t[nleft] ?? 0;
        ibp = iorder[nleft] ?? 0;
      }
      const dt = tj - tj0;
      if (dtm < dt) {
        if (dtm <= 0) dtm = 0;
        tsum += dtm;
        daxpy(n, tsum, d, xcp);
        if (col > 0) daxpy(col2, dtm, p, c);
        return 0;
      }
      tsum += dt;
      nleft -= 1;
      iter += 1;
      let dibp = d[ibp] ?? 0;
      d[ibp] = 0;
      let zibp: number;
      if (dibp > 0) {
        zibp = (u[ibp] ?? 0) - (x[ibp] ?? 0);
        xcp[ibp] = u[ibp] ?? 0;
        iwhere[ibp] = 2;
      } else {
        zibp = (l[ibp] ?? 0) - (x[ibp] ?? 0);
        xcp[ibp] = l[ibp] ?? 0;
        iwhere[ibp] = 1;
      }
      if (nleft === -1 && nbreak === n) {
        dtm = dt;
        if (col > 0) daxpy(col2, dtm, p, c);
        return 0;
      }
      const dibp2 = dibp ** 2;
      f1 = f1 + dt * f2 + dibp2 - theta * dibp * zibp;
      f2 -= theta * dibp2;
      if (col > 0) {
        daxpy(col2, dt, p, c);
        let pointr = head;
        for (let j = 0; j < col; j++) {
          wbp[j] = wy[ibp + n * pointr] ?? 0;
          wbp[col + j] = theta * (ws[ibp + n * pointr] ?? 0);
          pointr = (pointr + 1) % m;
        }
        const info = this.bmv(col, wbp, v);
        if (info !== 0) return info;
        const wmc = ddot(col2, c, 0, v, 0);
        const wmp = ddot(col2, p, 0, v, 0);
        const wmw = ddot(col2, wbp, 0, v, 0);
        dibp = -dibp;
        daxpy(col2, dibp, wbp, p);
        dibp = -dibp;
        f1 += dibp * wmc;
        f2 = f2 + dibp * 2 * wmp - dibp2 * wmw;
      }
      f2 = Math.max(EPSMACH * f2Org, f2);
      if (nleft >= 0) dtm = -f1 / f2;
      else if (bnded) {
        dtm = 0;
        break;
      } else {
        dtm = -f1 / f2;
        break;
      }
    }
    if (dtm <= 0) dtm = 0;
    tsum += dtm;
    daxpy(n, tsum, d, xcp);
    if (col > 0) daxpy(col2, dtm, p, c);
    return 0;
  }

  // cmprlb: r = -Z'B(xcp - x) - Z'g, in r.
  cmprlb(
    x: Float64Array,
    g: Float64Array,
    theta: number,
    col: number,
    head: number,
    nfree: number,
    cnstnd: boolean,
  ): number {
    const { n, m, ws, wy, z, r, wa, index } = this;
    if (!cnstnd && col > 0) {
      for (let i = 0; i < n; i++) r[i] = -(g[i] ?? 0);
      return 0;
    }
    for (let i = 0; i < nfree; i++) {
      const k = index[i] ?? 0;
      r[i] = -theta * ((z[k] ?? 0) - (x[k] ?? 0)) - (g[k] ?? 0);
    }
    if (this.bmv(col, wa.subarray(2 * m, 4 * m), wa) !== 0) return -8;
    let pointr = head;
    for (let j = 0; j < col; j++) {
      const a1 = wa[j] ?? 0;
      const a2 = theta * (wa[col + j] ?? 0);
      for (let i = 0; i < nfree; i++) {
        const k = index[i] ?? 0;
        r[i] =
          (r[i] ?? 0) +
          (wy[k + n * pointr] ?? 0) * a1 +
          (ws[k + n * pointr] ?? 0) * a2;
      }
      pointr = (pointr + 1) % m;
    }
    return 0;
  }

  // formk: the LEL^T factorization of the indefinite matrix K, in wn.
  formk(
    nsub: number,
    nenter: number,
    ileave: number,
    iupdat: number,
    updatd: boolean,
    theta: number,
    col: number,
    head: number,
  ): number {
    const { n, m, ws, wy, sy, wn } = this;
    const wn1 = this.snd;
    const ind = this.index;
    const indx2 = this.indx2;
    const m2 = 2 * m;
    let upcl: number;
    if (updatd) {
      if (iupdat > m)
        for (let jy = 0; jy < m - 1; jy++) {
          const js = m + jy;
          const length = m - (jy + 1);
          dcopy(length, wn1, jy + 1 + m2 * (jy + 1), wn1, jy + m2 * jy);
          dcopy(length, wn1, js + 1 + m2 * (js + 1), wn1, js + m2 * js);
          dcopy(m - 1, wn1, m + 1 + m2 * (jy + 1), wn1, m + m2 * jy);
        }
      const iy = col - 1;
      let is = m + col - 1;
      let ipntr = head + col - 1;
      if (ipntr >= m) ipntr -= m;
      let jpntr = head;
      for (let jy = 0; jy < col; jy++) {
        const js = m + jy;
        let temp1 = 0;
        let temp2 = 0;
        let temp3 = 0;
        for (let k = 0; k < nsub; k++) {
          const k1 = ind[k] ?? 0;
          temp1 += (wy[k1 + n * ipntr] ?? 0) * (wy[k1 + n * jpntr] ?? 0);
        }
        for (let k = nsub; k < n; k++) {
          const k1 = ind[k] ?? 0;
          temp2 += (ws[k1 + n * ipntr] ?? 0) * (ws[k1 + n * jpntr] ?? 0);
          temp3 += (ws[k1 + n * ipntr] ?? 0) * (wy[k1 + n * jpntr] ?? 0);
        }
        wn1[iy + m2 * jy] = temp1;
        wn1[is + m2 * js] = temp2;
        wn1[is + m2 * jy] = temp3;
        jpntr = (jpntr + 1) % m;
      }
      const jy = col - 1;
      jpntr = head + col - 1;
      if (jpntr >= m) jpntr -= m;
      ipntr = head;
      for (let i = 0; i < col; i++) {
        is = m + i;
        let temp3 = 0;
        for (let k = 0; k < nsub; k++) {
          const k1 = ind[k] ?? 0;
          temp3 += (ws[k1 + n * ipntr] ?? 0) * (wy[k1 + n * jpntr] ?? 0);
        }
        ipntr = (ipntr + 1) % m;
        wn1[is + m2 * jy] = temp3;
      }
      upcl = col - 1;
    } else upcl = col;

    let ipntr = head;
    for (let iy = 0; iy < upcl; iy++) {
      const is = m + iy;
      let jpntr = head;
      for (let jy = 0; jy <= iy; jy++) {
        const js = m + jy;
        let temp1 = 0;
        let temp2 = 0;
        let temp3 = 0;
        let temp4 = 0;
        for (let k = 0; k < nenter; k++) {
          const k1 = indx2[k] ?? 0;
          temp1 += (wy[k1 + n * ipntr] ?? 0) * (wy[k1 + n * jpntr] ?? 0);
          temp2 += (ws[k1 + n * ipntr] ?? 0) * (ws[k1 + n * jpntr] ?? 0);
        }
        for (let k = ileave; k < n; k++) {
          const k1 = indx2[k] ?? 0;
          temp3 += (wy[k1 + n * ipntr] ?? 0) * (wy[k1 + n * jpntr] ?? 0);
          temp4 += (ws[k1 + n * ipntr] ?? 0) * (ws[k1 + n * jpntr] ?? 0);
        }
        wn1[iy + m2 * jy] = (wn1[iy + m2 * jy] ?? 0) + temp1 - temp3;
        wn1[is + m2 * js] = (wn1[is + m2 * js] ?? 0) - temp2 + temp4;
        jpntr = (jpntr + 1) % m;
      }
      ipntr = (ipntr + 1) % m;
    }

    ipntr = head;
    for (let is = m; is < m + upcl; is++) {
      let jpntr = head;
      for (let jy = 0; jy < upcl; jy++) {
        let temp1 = 0;
        let temp3 = 0;
        for (let k = 0; k < nenter; k++) {
          const k1 = indx2[k] ?? 0;
          temp1 += (ws[k1 + n * ipntr] ?? 0) * (wy[k1 + n * jpntr] ?? 0);
        }
        for (let k = ileave; k < n; k++) {
          const k1 = indx2[k] ?? 0;
          temp3 += (ws[k1 + n * ipntr] ?? 0) * (wy[k1 + n * jpntr] ?? 0);
        }
        if (is <= jy + m)
          wn1[is + m2 * jy] = (wn1[is + m2 * jy] ?? 0) + temp1 - temp3;
        else wn1[is + m2 * jy] = (wn1[is + m2 * jy] ?? 0) - temp1 + temp3;
        jpntr = (jpntr + 1) % m;
      }
      ipntr = (ipntr + 1) % m;
    }

    for (let iy = 0; iy < col; iy++) {
      const is = col + iy;
      const is1 = m + iy;
      for (let jy = 0; jy <= iy; jy++) {
        const js = col + jy;
        const js1 = m + jy;
        wn[jy + m2 * iy] = (wn1[iy + m2 * jy] ?? 0) / theta;
        wn[js + m2 * is] = (wn1[is1 + m2 * js1] ?? 0) * theta;
      }
      for (let jy = 0; jy < iy; jy++)
        wn[jy + m2 * is] = -(wn1[is1 + m2 * jy] ?? 0);
      for (let jy = iy; jy < col; jy++)
        wn[jy + m2 * is] = wn1[is1 + m2 * jy] ?? 0;
      wn[iy + m2 * iy] = (wn[iy + m2 * iy] ?? 0) + (sy[iy + m * iy] ?? 0);
    }

    if (dpotrf(col, wn, 0, m2) !== 0) return -1;
    const col2 = 2 * col;
    dtrtrs(true, col, col, wn, 0, m2, wn, m2 * col, m2);
    for (let is = col; is < col2; is++)
      for (let js = is; js < col2; js++)
        wn[is + m2 * js] =
          (wn[is + m2 * js] ?? 0) + ddot(col, wn, m2 * is, wn, m2 * js);
    if (dpotrf(col, wn, col + m2 * col, m2) !== 0) return -2;
    return 0;
  }

  // formt: T = theta*SS + L*D^(-1)*L' and its Cholesky factor, in wt.
  formt(col: number, theta: number): number {
    const { m, wt, sy, ss } = this;
    for (let j = 0; j < col; j++) wt[m * j] = theta * (ss[m * j] ?? 0);
    for (let i = 1; i < col; i++)
      for (let j = i; j < col; j++) {
        const k1 = Math.min(i, j);
        let ddum = 0;
        for (let k = 0; k < k1; k++)
          ddum +=
            ((sy[i + m * k] ?? 0) * (sy[j + m * k] ?? 0)) /
            (sy[k + m * k] ?? 0);
        wt[i + m * j] = ddum + theta * (ss[i + m * j] ?? 0);
      }
    return dpotrf(col, wt, 0, m) === 0 ? 0 : -3;
  }

  // freev: the entering and leaving variables, and the free and active
  // variables at the generalized Cauchy point, in index.
  freev(
    nfreeBefore: number,
    updatd: boolean,
    cnstnd: boolean,
    iter: number,
  ): { nfree: number; nenter: number; ileave: number; wrk: boolean } {
    const { n, iwhere } = this;
    const idx = this.index;
    const idx2 = this.indx2;
    let nenter = 0;
    let ileave = n;
    if (iter > 0 && cnstnd) {
      for (let i = 0; i < nfreeBefore; i++) {
        const k = idx[i] ?? 0;
        if ((iwhere[k] ?? 0) > 0) {
          ileave -= 1;
          idx2[ileave] = k;
        }
      }
      for (let i = nfreeBefore; i < n; i++) {
        const k = idx[i] ?? 0;
        if ((iwhere[k] ?? 0) <= 0) {
          idx2[nenter] = k;
          nenter += 1;
        }
      }
    }
    const wrk = ileave < n || nenter > 0 || updatd;
    let nfree = 0;
    let iact = n;
    for (let i = 0; i < n; i++) {
      if ((iwhere[i] ?? 0) <= 0) {
        idx[nfree] = i;
        nfree += 1;
      } else {
        iact -= 1;
        idx[iact] = i;
      }
    }
    return { nfree, nenter, ileave, wrk };
  }

  // matupd: adds the new s and y to WS and WY, and updates SY, SS and
  // theta.
  matupd(
    itailBefore: number,
    iupdat: number,
    colBefore: number,
    headBefore: number,
    rr: number,
    dr: number,
    stp: number,
    dtd: number,
  ): { itail: number; col: number; head: number; theta: number } {
    const { n, m, ws, wy, sy, ss, d, r } = this;
    let itail = itailBefore;
    let col = colBefore;
    let head = headBefore;
    if (iupdat <= m) {
      col = iupdat;
      itail = (head + iupdat - 1) % m;
    } else {
      itail = (itail + 1) % m;
      head = (head + 1) % m;
    }
    ws.set(d, itail * n);
    wy.set(r, itail * n);
    const theta = rr / dr;
    if (iupdat > m)
      for (let j = 1; j < col; j++) {
        dcopy(j, ss, 1 + m * j, ss, m * (j - 1));
        dcopy(col - j, sy, j + m * j, sy, j - 1 + m * (j - 1));
      }
    let pointr = head;
    for (let j = 0; j < col - 1; j++) {
      sy[col - 1 + m * j] = ddot(n, d, 0, wy, pointr * n);
      ss[j + m * (col - 1)] = ddot(n, ws, pointr * n, d, 0);
      pointr = (pointr + 1) % m;
    }
    ss[col - 1 + m * (col - 1)] = stp === 1 ? dtd : stp * stp * dtd;
    sy[col - 1 + m * (col - 1)] = dr;
    return { itail, col, head, theta };
  }

  // projgr: the infinity norm of the projected gradient.
  projgr(x: Float64Array, g: Float64Array): number {
    const { n, l, u, nbd } = this;
    let sbgnrm = 0;
    for (let i = 0; i < n; i++) {
      let gi = g[i] ?? 0;
      if (Number.isNaN(gi)) return gi;
      const bound = nbd[i] ?? 0;
      if (bound !== 0) {
        if (gi < 0) {
          if (bound >= 2) gi = Math.max((x[i] ?? 0) - (u[i] ?? 0), gi);
        } else if (bound <= 2) gi = Math.min((x[i] ?? 0) - (l[i] ?? 0), gi);
      }
      sbgnrm = Math.max(sbgnrm, Math.abs(gi));
    }
    return sbgnrm;
  }

  // subsm: the subspace minimization from the Cauchy point z, with the
  // reduced gradient in r; the projected Newton point lands in z.
  subsm(
    nsub: number,
    xx: Float64Array,
    gg: Float64Array,
    theta: number,
    col: number,
    head: number,
  ): number {
    const { n, m, l, u, nbd, ws, wy, wn, xp } = this;
    const ind = this.index;
    const x = this.z;
    const d = this.r;
    const wv = this.wa;
    let iword = 0;
    if (nsub <= 0) return 0;
    let pointr = head;
    for (let i = 0; i < col; i++) {
      let temp1 = 0;
      let temp2 = 0;
      for (let j = 0; j < nsub; j++) {
        const k = ind[j] ?? 0;
        temp1 += (wy[k + n * pointr] ?? 0) * (d[j] ?? 0);
        temp2 += (ws[k + n * pointr] ?? 0) * (d[j] ?? 0);
      }
      wv[i] = temp1;
      wv[col + i] = theta * temp2;
      pointr = (pointr + 1) % m;
    }
    const m2 = 2 * m;
    const col2 = 2 * col;
    let info = dtrtrs(true, col2, 1, wn, 0, m2, wv, 0, m2);
    if (info !== 0) return info;
    for (let i = 0; i < col; i++) wv[i] = -(wv[i] ?? 0);
    info = dtrtrs(false, col2, 1, wn, 0, m2, wv, 0, m2);
    if (info !== 0) return info;
    pointr = head;
    for (let jy = 0; jy < col; jy++) {
      const js = col + jy;
      for (let i = 0; i < nsub; i++) {
        const k = ind[i] ?? 0;
        d[i] =
          (d[i] ?? 0) +
          ((wy[k + n * pointr] ?? 0) * (wv[jy] ?? 0)) / theta +
          (ws[k + n * pointr] ?? 0) * (wv[js] ?? 0);
      }
      pointr = (pointr + 1) % m;
    }
    const scale = 1 / theta;
    for (let i = 0; i < nsub; i++) d[i] = scale * (d[i] ?? 0);

    xp.set(x);
    for (let i = 0; i < nsub; i++) {
      const k = ind[i] ?? 0;
      const dk = d[i] ?? 0;
      const xk = x[k] ?? 0;
      const bound = nbd[k] ?? 0;
      if (bound === 0) x[k] = xk + dk;
      else if (bound === 1) {
        x[k] = Math.max(l[k] ?? 0, xk + dk);
        if (x[k] === l[k]) iword = 1;
      } else if (bound === 2) {
        x[k] = Math.min(u[k] ?? 0, Math.max(l[k] ?? 0, xk + dk));
        if (x[k] === l[k] || x[k] === u[k]) iword = 1;
      } else if (bound === 3) {
        x[k] = Math.min(u[k] ?? 0, xk + dk);
        if (x[k] === u[k]) iword = 1;
      }
    }
    if (iword === 0) return 0;
    let ddP = 0;
    for (let i = 0; i < n; i++)
      ddP += ((x[i] ?? 0) - (xx[i] ?? 0)) * (gg[i] ?? 0);
    if (ddP > 0) x.set(xp);
    else return 0;

    let alpha = 1;
    let temp1 = 1;
    let ibd = 0;
    for (let i = 0; i < nsub; i++) {
      const k = ind[i] ?? 0;
      const dk = d[i] ?? 0;
      const bound = nbd[k] ?? 0;
      if (bound !== 0) {
        if (dk < 0 && bound <= 2) {
          const temp2 = (l[k] ?? 0) - (x[k] ?? 0);
          if (temp2 >= 0) temp1 = 0;
          else if (dk * alpha < temp2) temp1 = temp2 / dk;
        } else if (dk > 0 && bound >= 2) {
          const temp2 = (u[k] ?? 0) - (x[k] ?? 0);
          if (temp2 <= 0) temp1 = 0;
          else if (dk * alpha > temp2) temp1 = temp2 / dk;
        }
        if (temp1 < alpha) {
          alpha = temp1;
          ibd = i;
        }
      }
    }
    if (alpha < 1) {
      const dk = d[ibd] ?? 0;
      const k = ind[ibd] ?? 0;
      if (dk > 0) {
        x[k] = u[k] ?? 0;
        d[ibd] = 0;
      } else if (dk < 0) {
        x[k] = l[k] ?? 0;
        d[ibd] = 0;
      }
    }
    for (let i = 0; i < nsub; i++) {
      const k = ind[i] ?? 0;
      x[k] = (x[k] ?? 0) + alpha * (d[i] ?? 0);
    }
    return 0;
  }
}

// hpsolb: the heap of the breakpoints t[0..n] with their indices; it moves
// the least of them to t[n].
function hpsolb(
  n: number,
  t: Float64Array,
  iorder: Int32Array,
  iheap: number,
): void {
  if (iheap === 0)
    for (let k = 2; k <= n + 1; k++) {
      const ddum = t[k - 1] ?? 0;
      const indxin = iorder[k - 1] ?? 0;
      let i = k;
      while (i > 1) {
        const j = Math.trunc(i / 2);
        if (ddum < (t[j - 1] ?? 0)) {
          t[i - 1] = t[j - 1] ?? 0;
          iorder[i - 1] = iorder[j - 1] ?? 0;
          i = j;
        } else break;
      }
      t[i - 1] = ddum;
      iorder[i - 1] = indxin;
    }
  if (n > 0) {
    let i = 1;
    const out = t[0] ?? 0;
    const indxout = iorder[0] ?? 0;
    const ddum = t[n] ?? 0;
    const indxin = iorder[n] ?? 0;
    for (;;) {
      let j = i + i;
      if (j > n) break;
      if ((t[j] ?? 0) < (t[j - 1] ?? 0)) j++;
      if ((t[j - 1] ?? 0) < ddum) {
        t[i - 1] = t[j - 1] ?? 0;
        iorder[i - 1] = iorder[j - 1] ?? 0;
        i = j;
      } else break;
    }
    t[i - 1] = ddum;
    iorder[i - 1] = indxin;
    t[n] = out;
    iorder[n] = indxout;
  }
}

// dcsrch of MINPACK-2: a step that satisfies the strong Wolfe conditions,
// by the safeguarded cubic and quadratic steps of dcstep. It returns the
// next step; search.task says whether it wants f and g there.
function dcsrch(
  f: number,
  g: number,
  stpIn: number,
  ftol: number,
  gtol: number,
  xtol: number,
  stpmin: number,
  stpmax: number,
  search: LineSearch,
): number {
  let stp = stpIn;
  const xtrapl = 1.1;
  const xtrapu = 4;
  if (search.task === Task.START) {
    let message: number | null = null;
    if (stp < stpmin) message = ERROR_STP1;
    if (stp > stpmax) message = ERROR_STP2;
    if (g >= 0) message = ERROR_INITG;
    if (ftol < 0) message = ERROR_FTOL;
    if (gtol < 0) message = ERROR_GTOL;
    if (xtol < 0) message = ERROR_XTOL;
    if (stpmin < 0) message = ERROR_STPMIN;
    if (stpmax < stpmin) message = ERROR_STPMAX;
    if (message !== null) {
      search.task = Task.ERROR;
      search.taskMsg = message;
      return stp;
    }
    search.brackt = false;
    search.stage = 1;
    search.finit = f;
    search.ginit = g;
    search.gtest = ftol * g;
    search.width = stpmax - stpmin;
    search.width1 = search.width / 0.5;
    search.stx = 0;
    search.fx = f;
    search.gx = g;
    search.sty = 0;
    search.fy = f;
    search.gy = g;
    search.stmin = 0;
    search.stmax = stp + xtrapu * stp;
    search.task = Task.FG;
    search.taskMsg = NO_MSG;
    return stp;
  }
  const ftest = search.finit + stp * search.gtest;
  if (search.stage === 1 && f <= ftest && g >= 0) search.stage = 2;
  if (search.brackt && (stp <= search.stmin || stp >= search.stmax)) {
    search.task = Task.WARNING;
    search.taskMsg = WARN_ROUND;
  }
  if (search.brackt && search.stmax - search.stmin <= xtol * search.stmax) {
    search.task = Task.WARNING;
    search.taskMsg = WARN_XTOL;
  }
  if (stp === stpmax && f <= ftest && g <= search.gtest) {
    search.task = Task.WARNING;
    search.taskMsg = WARN_STPMAX;
  }
  if (stp === stpmin && (f > ftest || g >= search.gtest)) {
    search.task = Task.WARNING;
    search.taskMsg = WARN_STPMIN;
  }
  if (f <= ftest && Math.abs(g) <= gtol * -search.ginit)
    search.task = Task.CONVERGENCE;
  if (search.task === Task.WARNING || search.task === Task.CONVERGENCE)
    return stp;

  if (search.stage === 1 && f <= search.fx && f > ftest) {
    const step: Step = {
      stx: search.stx,
      fx: search.fx - search.stx * search.gtest,
      dx: search.gx - search.gtest,
      sty: search.sty,
      fy: search.fy - search.sty * search.gtest,
      dy: search.gy - search.gtest,
      stp,
      brackt: search.brackt,
    };
    dcstep(
      step,
      f - stp * search.gtest,
      g - search.gtest,
      search.stmin,
      search.stmax,
    );
    search.stx = step.stx;
    search.sty = step.sty;
    search.brackt = step.brackt;
    stp = step.stp;
    search.fx = step.fx + step.stx * search.gtest;
    search.fy = step.fy + step.sty * search.gtest;
    search.gx = step.dx + search.gtest;
    search.gy = step.dy + search.gtest;
  } else {
    const step: Step = {
      stx: search.stx,
      fx: search.fx,
      dx: search.gx,
      sty: search.sty,
      fy: search.fy,
      dy: search.gy,
      stp,
      brackt: search.brackt,
    };
    dcstep(step, f, g, search.stmin, search.stmax);
    search.stx = step.stx;
    search.fx = step.fx;
    search.gx = step.dx;
    search.sty = step.sty;
    search.fy = step.fy;
    search.gy = step.dy;
    search.brackt = step.brackt;
    stp = step.stp;
  }

  if (search.brackt) {
    if (Math.abs(search.sty - search.stx) >= 0.66 * search.width1)
      stp = search.stx + 0.5 * (search.sty - search.stx);
    search.width1 = search.width;
    search.width = Math.abs(search.sty - search.stx);
  }
  if (search.brackt) {
    search.stmin = Math.min(search.stx, search.sty);
    search.stmax = Math.max(search.stx, search.sty);
  } else {
    search.stmin = stp + xtrapl * (stp - search.stx);
    search.stmax = stp + xtrapu * (stp - search.stx);
  }
  stp = Math.max(stp, stpmin);
  stp = Math.min(stp, stpmax);
  if (
    (search.brackt && (stp <= search.stmin || stp >= search.stmax)) ||
    (search.brackt && search.stmax - search.stmin <= xtol * search.stmax)
  )
    stp = search.stx;
  search.task = Task.FG;
  search.taskMsg = NO_MSG;
  return stp;
}

// The interval of dcstep: the best step stx, the other end sty and the
// trial step stp, with their function values and derivatives.
type Step = {
  stx: number;
  fx: number;
  dx: number;
  sty: number;
  fy: number;
  dy: number;
  stp: number;
  brackt: boolean;
};

// dcstep of MINPACK-2: the next trial step, and the new interval that
// holds a minimizer.
function dcstep(
  step: Step,
  fp: number,
  dp: number,
  stpmin: number,
  stpmax: number,
): void {
  const { stx, fx, dx, sty, fy, dy, stp } = step;
  const sgnd = dp * (dx / Math.abs(dx));
  let stpf: number;
  if (fp > fx) {
    const theta = (3 * (fx - fp)) / (stp - stx) + dx + dp;
    const s = Math.max(Math.abs(theta), Math.abs(dx), Math.abs(dp));
    let gamma = s * Math.sqrt((theta / s) ** 2 - (dx / s) * (dp / s));
    if (stp < stx) gamma = -gamma;
    const p = gamma - dx + theta;
    const q = gamma - dx + gamma + dp;
    const r = p / q;
    const stpc = stx + r * (stp - stx);
    const stpq = stx + (dx / ((fx - fp) / (stp - stx) + dx) / 2) * (stp - stx);
    stpf =
      Math.abs(stpc - stx) < Math.abs(stpq - stx)
        ? stpc
        : stpc + (stpq - stpc) / 2;
    step.brackt = true;
  } else if (sgnd < 0) {
    const theta = (3 * (fx - fp)) / (stp - stx) + dx + dp;
    const s = Math.max(Math.abs(theta), Math.abs(dx), Math.abs(dp));
    let gamma = s * Math.sqrt((theta / s) ** 2 - (dx / s) * (dp / s));
    if (stp > stx) gamma = -gamma;
    const p = gamma - dp + theta;
    const q = gamma - dp + gamma + dx;
    const r = p / q;
    const stpc = stp + r * (stx - stp);
    const stpq = stp + (dp / (dp - dx)) * (stx - stp);
    stpf = Math.abs(stpc - stp) > Math.abs(stpq - stp) ? stpc : stpq;
    step.brackt = true;
  } else if (Math.abs(dp) < Math.abs(dx)) {
    const theta = (3 * (fx - fp)) / (stp - stx) + dx + dp;
    const s = Math.max(Math.abs(theta), Math.abs(dx), Math.abs(dp));
    let gamma =
      s * Math.sqrt(Math.max(0, (theta / s) ** 2 - (dx / s) * (dp / s)));
    if (stp > stx) gamma = -gamma;
    const p = gamma - dp + theta;
    const q = gamma + (dx - dp) + gamma;
    const r = p / q;
    let stpc: number;
    if (r < 0 && gamma !== 0) stpc = stp + r * (stx - stp);
    else if (stp > stx) stpc = stpmax;
    else stpc = stpmin;
    const stpq = stp + (dp / (dp - dx)) * (stx - stp);
    if (step.brackt) {
      stpf = Math.abs(stpc - stp) < Math.abs(stpq - stp) ? stpc : stpq;
      stpf =
        stp > stx
          ? Math.min(stp + 0.66 * (sty - stp), stpf)
          : Math.max(stp + 0.66 * (sty - stp), stpf);
    } else {
      stpf = Math.abs(stpc - stp) > Math.abs(stpq - stp) ? stpc : stpq;
      stpf = Math.min(stpmax, stpf);
      stpf = Math.max(stpmin, stpf);
    }
  } else if (step.brackt) {
    const theta = (3 * (fp - fy)) / (sty - stp) + dy + dp;
    const s = Math.max(Math.abs(theta), Math.abs(dy), Math.abs(dp));
    let gamma = s * Math.sqrt((theta / s) ** 2 - (dy / s) * (dp / s));
    if (stp > sty) gamma = -gamma;
    const p = gamma - dp + theta;
    const q = gamma - dp + gamma + dy;
    const r = p / q;
    stpf = stp + r * (sty - stp);
  } else stpf = stp > stx ? stpmax : stpmin;

  if (fp > fx) {
    step.sty = stp;
    step.fy = fp;
    step.dy = dp;
  } else {
    if (sgnd < 0) {
      step.sty = stx;
      step.fy = fx;
      step.dy = dx;
    }
    step.stx = stp;
    step.fx = fp;
    step.dx = dp;
  }
  step.stp = stpf;
}

// dnrm2: the Euclidean norm of the first n values of x.
function dnrm2(n: number, x: Float64Array): number {
  return Math.sqrt(ddot(n, x, 0, x, 0));
}

// daxpy: y += a * x for the first n values.
function daxpy(n: number, a: number, x: Float64Array, y: Float64Array): void {
  for (let i = 0; i < n; i++) y[i] = (y[i] ?? 0) + a * (x[i] ?? 0);
}

// dcopy: n values from x at offsetX to y at offsetY. BLAS copies them one
// by one, from the first, also where the ranges overlap.
function dcopy(
  n: number,
  x: Float64Array,
  offsetX: number,
  y: Float64Array,
  offsetY: number,
): void {
  for (let i = 0; i < n; i++) y[offsetY + i] = x[offsetX + i] ?? 0;
}

// dpotrf with uplo "U": the Cholesky factor U of the n x n matrix at
// offset (U'U = A), in its upper triangle. The reference dpotf2 without
// blocks. It returns j + 1 when the leading minor of order j + 1 is not
// positive definite, else 0.
function dpotrf(
  n: number,
  a: Float64Array,
  offset: number,
  lda: number,
): number {
  const at = (i: number, j: number) => offset + i + lda * j;
  for (let j = 0; j < n; j++) {
    let ajj = (a[at(j, j)] ?? 0) - ddot(j, a, at(0, j), a, at(0, j));
    if (ajj <= 0 || Number.isNaN(ajj)) {
      a[at(j, j)] = ajj;
      return j + 1;
    }
    ajj = Math.sqrt(ajj);
    a[at(j, j)] = ajj;
    for (let c = j + 1; c < n; c++) {
      const value = (a[at(j, c)] ?? 0) - ddot(j, a, at(0, j), a, at(0, c));
      a[at(j, c)] = value / ajj;
    }
  }
  return 0;
}

// dtrtrs with uplo "U" and diag "N": solves U' X = B (transposed) or
// U X = B for the nrhs columns of B at offsetB, in place. It returns i + 1
// when the diagonal value i of U is 0, else 0.
function dtrtrs(
  transposed: boolean,
  n: number,
  nrhs: number,
  a: Float64Array,
  offsetA: number,
  lda: number,
  b: Float64Array,
  offsetB: number,
  ldb: number,
): number {
  const at = (i: number, j: number) => offsetA + i + lda * j;
  for (let i = 0; i < n; i++) if (a[at(i, i)] === 0) return i + 1;
  for (let column = 0; column < nrhs; column++) {
    const base = offsetB + ldb * column;
    if (transposed)
      for (let i = 0; i < n; i++) {
        let temp = b[base + i] ?? 0;
        for (let k = 0; k < i; k++)
          temp -= (a[at(k, i)] ?? 0) * (b[base + k] ?? 0);
        b[base + i] = temp / (a[at(i, i)] ?? 0);
      }
    else
      for (let j = n - 1; j >= 0; j--) {
        if (b[base + j] === 0) continue;
        const value = (b[base + j] ?? 0) / (a[at(j, j)] ?? 0);
        b[base + j] = value;
        for (let i = 0; i < j; i++)
          b[base + i] = (b[base + i] ?? 0) - value * (a[at(i, j)] ?? 0);
      }
  }
  return 0;
}
