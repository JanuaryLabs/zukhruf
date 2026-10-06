export interface DepConstraint {
  sourceTag: string;
  onlyDependOnLibsWithTags?: string[];
  notDependOnLibsWithTags?: string[];
  bannedExternalImports?: string[];
  allowedExternalImports?: string[];
}

export interface ModuleBoundaryOptions {
  /** Import paths exempt from every constraint, as regexes. */
  allow?: string[];
  depConstraints?: DepConstraint[];
  checkDynamicDependenciesExceptions?: string[];
  banTransitiveDependencies?: boolean;
  enforceBuildableLibDependency?: boolean;
}

// ESLint configs import presets across project boundaries by design.
const ESLINT_CONFIG_FILES = '^.*/eslint(\\.base)?\\.config\\.[cm]?js$';

/**
 * Options for `@nx/enforce-module-boundaries`: the shared ones, with the
 * repo's own `allow` entries and constraints appended rather than replacing
 * them. Setting the rule with only the repo's constraints would drop the rest,
 * the way partial `dependency-checks` options dropped the shared policy.
 */
export function moduleBoundaries({
  allow = [],
  depConstraints = [],
  ...rest
}: ModuleBoundaryOptions = {}) {
  return {
    enforceBuildableLibDependency: true,
    ...rest,
    allow: [ESLINT_CONFIG_FILES, ...allow],
    depConstraints: [
      { sourceTag: '*', onlyDependOnLibsWithTags: ['*'] },
      ...depConstraints,
    ],
  };
}
