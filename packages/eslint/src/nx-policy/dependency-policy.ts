import { TESTS } from '../files.ts';

export interface DependencyPolicyOptions {
  ignoredFiles?: string[];
  ignoredDependencies?: string[];
  includeTransitiveDependencies?: boolean;
  checkMissingDependencies?: boolean;
  checkObsoleteDependencies?: boolean;
  checkVersionMismatches?: boolean;
  buildTargets?: string[];
}

// Test and build-tool files never ship, so their imports are not dependencies.
const NEVER_SHIPPED = [
  ...TESTS.map((glob) => `{projectRoot}/${glob}`),
  '{projectRoot}/**/{tests,test,e2e,__tests__,__mocks__}/**',
  '{projectRoot}/**/test-setup.{ts,tsx,mts,cts}',
  '{projectRoot}/*.config.{js,cjs,mjs,ts,mts,cts}',
];

/**
 * Options for `@nx/dependency-checks`: a package declares every package its
 * shipped code imports, and only its direct imports. Obsolete dependencies are
 * not checked: the check sees static imports only, so it would flag a package
 * loaded through a dynamic import(), a CSS `@source` or a CLI.
 *
 * A project's `ignoredFiles` and `ignoredDependencies` are appended to the
 * policy. Setting the rule with only those arrays would let the rule's own
 * defaults fill in the rest — obsolete-dependency checks on, test files counted
 * as shipped — which is how per-project configs silently lost the policy.
 */
export function dependencyPolicy({
  ignoredFiles = [],
  ignoredDependencies = [],
  ...overrides
}: DependencyPolicyOptions = {}) {
  return {
    includeTransitiveDependencies: false,
    checkMissingDependencies: true,
    checkObsoleteDependencies: false,
    checkVersionMismatches: true,
    ...overrides,
    ignoredFiles: [...NEVER_SHIPPED, ...ignoredFiles],
    ignoredDependencies: [...ignoredDependencies],
  };
}
