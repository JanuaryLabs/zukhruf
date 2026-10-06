export { default } from './island/plugin.ts';
export {
  dependencyPolicy,
  type DependencyPolicyOptions,
} from './nx-policy/dependency-policy.ts';
export { ISLAND_TAG, islandConstraint } from './nx-policy/island-constraint.ts';
export {
  type DepConstraint,
  moduleBoundaries,
  type ModuleBoundaryOptions,
} from './nx-policy/module-boundaries.ts';
