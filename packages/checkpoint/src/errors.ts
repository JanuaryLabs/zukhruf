import type { FencingToken } from '@zukhruf/fencing';

import type { CheckpointKey } from './checkpoint.ts';

function describe(key: CheckpointKey): string {
  return `${key.consumerGroup}/${key.stream}/${key.partition}`;
}

/**
 * A commit found a newer epoch: a newer claim or a reset took the partition,
 * and the commit wrote nothing (ADR 0008). The reader stops.
 */
export class CheckpointFencedError extends Error {
  override readonly name = 'CheckpointFencedError';
  readonly key: CheckpointKey;
  /** The epoch of the claim that can no longer commit. */
  readonly epoch: FencingToken;

  constructor(key: CheckpointKey, epoch: FencingToken) {
    super(
      `Checkpoint ${describe(key)} was claimed or reset after epoch ${epoch.toString()}, so this claim cannot commit`,
    );
    this.key = key;
    this.epoch = epoch;
  }
}

/**
 * `decode` of a format threw for a stored version (ADR 0004). Migrate the
 * version in `decode`, or reset the partition.
 */
export class IncompatibleCheckpointError extends Error {
  override readonly name = 'IncompatibleCheckpointError';
  readonly key: CheckpointKey;
  /** The version that the stored value was written with. */
  readonly version: number;

  constructor(key: CheckpointKey, version: number, cause: unknown) {
    super(
      `Checkpoint ${describe(key)} holds a value of version ${version} that its format cannot read`,
      { cause },
    );
    this.key = key;
    this.version = version;
  }
}

/**
 * A stored checkpoint or value is not a valid record of its store. Only a
 * reset repairs it (ADR 0012).
 */
export class CorruptCheckpointError extends Error {
  override readonly name = 'CorruptCheckpointError';
  readonly key: CheckpointKey;

  constructor(key: CheckpointKey, detail: string) {
    super(`Checkpoint ${describe(key)} is corrupt: ${detail}`);
    this.key = key;
  }
}
