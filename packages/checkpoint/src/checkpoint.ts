import type { FencingToken } from '@zukhruf/fencing';

/** A value that JSON can hold. */
export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/**
 * How a value is written as JSON and read back, after Flink's
 * `SimpleVersionedSerializer` (ADR 0004). A commit writes `version` beside the
 * JSON, and a read gives the stored version to `decode`.
 */
export type Format<T> = {
  readonly version: number;
  encode(value: T): Json;
  /** Reads a value that `version` wrote. Throws when it cannot. */
  decode(version: number, json: Json): T;
};

/** A stream and one of its partitions (ADR 0003). */
export type StreamPartition = {
  readonly stream: string;
  readonly partition: string;
};

/** The consumer group, the stream and the partition of one checkpoint. */
export type CheckpointKey = StreamPartition & {
  readonly consumerGroup: string;
};

/** The saved progress of one partition (ADR 0005). */
export type Checkpoint<P> = {
  readonly position: P;
  /** 1 at the first commit of the partition, one more at each commit. */
  readonly checkpointId: number;
};

/** A value as a store keeps it: the JSON and the version of its format. */
export type StoredValue = {
  readonly version: number;
  readonly json: Json;
};

/** A checkpoint as a store keeps it. */
export type StoredCheckpoint = StoredValue & {
  readonly checkpointId: number;
};

/**
 * The changes of the map states of one commit, by state name (ADR 0006). A
 * store applies `cleared` first, then `deleted`, then `set`.
 */
export type StateChanges = {
  readonly cleared: ReadonlySet<string>;
  readonly deleted: ReadonlyMap<string, ReadonlySet<string>>;
  readonly set: ReadonlyMap<string, ReadonlyMap<string, StoredValue>>;
};

/** One partition of `list`: no position and no state (ADR 0009). */
export type CheckpointSummary = {
  readonly stream: string;
  readonly partition: string;
  readonly checkpointId: number;
  readonly epoch: FencingToken;
};

export type SignalOption = { readonly signal?: AbortSignal };
