import { PCG64 } from '../bit-generator/pcg64.ts';
import { SeedSequence } from '../seed/seed-sequence.ts';
import { Generator } from './generator.ts';

// numpy.random.default_rng(seed): a Generator over PCG64, seeded by a
// SeedSequence of the seed.
export function defaultRng(seed: number | bigint): Generator {
  return new Generator(new PCG64(new SeedSequence(seed)));
}
