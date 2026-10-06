import type { DepConstraint } from './module-boundaries.ts';

/** The Nx tag that makes a project an island. */
export const ISLAND_TAG = 'layer:island';

/**
 * The `@nx/enforce-module-boundaries` constraint for islands: an island depends
 * only on other islands and never imports a host's runtime (`hostRuntimes`,
 * e.g. `['electron', 'hono', 'hono/*']`).
 */
export function islandConstraint(
  hostRuntimes: readonly string[],
): DepConstraint {
  return {
    sourceTag: ISLAND_TAG,
    onlyDependOnLibsWithTags: [ISLAND_TAG],
    bannedExternalImports: [...hostRuntimes],
  };
}
