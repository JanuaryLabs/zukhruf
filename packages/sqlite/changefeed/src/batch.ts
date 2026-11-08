import type { ChangeEvent } from './change-event.ts';

/** The change events of one pass. A loop iterates it as it iterates an array. */
export class Batch implements Iterable<ChangeEvent> {
  readonly events: readonly ChangeEvent[];

  constructor(events: readonly ChangeEvent[]) {
    this.events = events;
  }

  [Symbol.iterator](): Iterator<ChangeEvent> {
    return this.events[Symbol.iterator]();
  }
}

/**
 * A batch of a durable position: its sequence is the number of the save that
 * keeps it. A batch given again after a stop has the same sequence, so a host
 * that keeps the last sequence it applied, in the transaction of its own
 * work, applies each batch one time (an idempotent consumer).
 */
export class SequencedBatch extends Batch {
  readonly sequence: number;

  constructor(events: readonly ChangeEvent[], sequence: number) {
    super(events);
    this.sequence = sequence;
  }
}
