export { ClosedWorld } from './closed-world.ts';
export { Coverage } from './coverage.ts';
export {
  DeletionPolicy,
  type KeyValue,
  type VanishedRecord,
  type Verdict,
} from './deletion-policy.ts';
export { Retention } from './retention.ts';
export {
  type FailedGroup,
  type KeptGroup,
  type SnapshotChange,
  SnapshotDifferential,
  type SnapshotDifferentialOptions,
  type SnapshotGroup,
} from './snapshot-differential.ts';
export type {
  GroupedSnapshot,
  GroupedSnapshotChanges,
  GroupedSnapshotState,
  KeyedChanges,
  SnapshotState,
} from './snapshot-state.ts';
