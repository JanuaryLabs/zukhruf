import type { CheckpointStore } from './checkpoint-store.ts';
import type {
  CheckpointKey,
  CheckpointSummary,
  Format,
  SignalOption,
  StoredCheckpoint,
  StreamPartition,
} from './checkpoint.ts';
import { IncompatibleCheckpointError } from './errors.ts';
import { PartitionContext } from './partition-context.ts';

/**
 * One reader of a stream, by name, as Kafka's `group.id` (ADR 0003). It claims
 * partitions, and it lists and resets their checkpoints.
 */
export class ConsumerGroup<W> {
  readonly name: string;
  readonly #store: CheckpointStore<W>;

  constructor(name: string, store: CheckpointStore<W>) {
    this.name = name;
    this.#store = store;
  }

  /**
   * Takes the partition with a new epoch, which fences each older claim, and
   * reads its checkpoint (ADRs 0005 and 0008).
   */
  async claim<P>(
    partition: StreamPartition,
    format: Format<P>,
    options?: SignalOption,
  ): Promise<PartitionContext<P, W>> {
    options?.signal?.throwIfAborted();
    const key: CheckpointKey = {
      consumerGroup: this.name,
      stream: partition.stream,
      partition: partition.partition,
    };
    const epoch = await this.#store.claim(key, options);
    const stored = await this.#store.read(key, options);
    return new PartitionContext(
      this.#store,
      key,
      epoch,
      format,
      stored === undefined
        ? undefined
        : {
            position: decode(key, format, stored),
            checkpointId: stored.checkpointId,
          },
    );
  }

  /** The partitions of this group that have a checkpoint (ADR 0009). */
  async *list(
    options?: SignalOption & { readonly stream?: string },
  ): AsyncIterable<CheckpointSummary> {
    options?.signal?.throwIfAborted();
    yield* this.#store.list(this.name, options);
  }

  /**
   * Removes the checkpoint and the map states of one partition, or of each
   * partition of a stream, and fences their live owners (ADR 0009).
   */
  async reset(
    target: { readonly stream: string; readonly partition?: string },
    options?: SignalOption,
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    await this.#store.reset(this.name, target, options);
  }
}

function decode<P>(
  key: CheckpointKey,
  format: Format<P>,
  stored: StoredCheckpoint,
): P {
  try {
    return format.decode(stored.version, stored.json);
  } catch (cause) {
    throw new IncompatibleCheckpointError(key, stored.version, cause);
  }
}
