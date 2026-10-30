// mteb/_evaluators/evaluator.py. MTEB's evaluator seeds the global random
// generators of Python, numpy and torch with seed; JavaScript has no seeded
// global generator, so an evaluator that needs randomness seeds its own.
export abstract class Evaluator {
  readonly seed: number;

  constructor(options: { readonly seed?: number } = {}) {
    this.seed = options.seed ?? 42;
  }
}
