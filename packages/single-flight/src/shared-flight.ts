import { type Lease, Modes, type Mutex } from '@zukhruf/mutex';

import { type FlightRecords, recordedError } from './flight-records.ts';
import { type Watch, findFlight, follow } from './follow.ts';
import {
  type FlightValue,
  type RunOptions,
  SingleFlight,
} from './single-flight.ts';

export interface SharedFlightOptions<T> {
  /** Decides who flies: only the holder of the key runs the work. */
  mutex: Mutex;
  /** Where the outcomes live, so callers in other processes can join. Never the lock directory of the mutex. */
  records: FlightRecords;
  /** Turns a value read back from a record into `T`. Every caller, the leader too, gets `parse` of the value as JSON. */
  parse: (value: unknown) => T;
  /** Milliseconds between two looks at a record while a caller joins. Defaults to 100. */
  pollInterval?: number;
}

/** What the local flight gives its callers: the value, and whether it came from a flight in another process. */
interface Arrival<T> {
  readonly value: T;
  readonly followed: boolean;
}

const skipIfBusy = Modes.skipIfBusy();

/** Values travel as JSON, so every caller gets the value in the shape that a joiner in another process reads. */
const encode = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value) ?? 'null');

/**
 * Callers of one key share the flight in progress, in this process and in
 * other processes. Callers in this process share one flight first. The holder
 * of the key leads the flight, and the records let callers in other
 * processes join it.
 */
export class SharedFlight<T> {
  readonly #local = new SingleFlight<Arrival<T>>();
  readonly #mutex: Mutex;
  readonly #records: FlightRecords;
  readonly #parse: (value: unknown) => T;
  readonly #pollInterval: number;

  constructor({
    mutex,
    records,
    parse,
    pollInterval = 100,
  }: SharedFlightOptions<T>) {
    if (!(pollInterval >= 0) || !Number.isFinite(pollInterval)) {
      throw new RangeError(
        `pollInterval must be a finite number of milliseconds >= 0, got ${pollInterval}.`,
      );
    }
    this.#mutex = mutex;
    this.#records = records;
    this.#parse = parse;
    this.#pollInterval = pollInterval;
  }

  async run(
    key: string,
    work: (lease: Lease) => Promise<T>,
    options: RunOptions = {},
  ): Promise<FlightValue<T>> {
    const { value, joined } = await this.#local.run(
      key,
      (abandoned) => this.#leadOrFollow(key, work, options.onJoin, abandoned),
      options,
    );
    return { value: value.value, joined: joined || value.followed };
  }

  /**
   * Runs for the first caller in this process. The callers that joined it
   * here heard `onJoin` already; this caller hears it once it joins a flight
   * of another process. Once no caller here waits (`abandoned`), it stops
   * looking and never takes the key; a flight that it leads runs to its end,
   * because callers in other processes can wait for its outcome.
   */
  async #leadOrFollow(
    key: string,
    work: (lease: Lease) => Promise<T>,
    onJoin: (() => void) | undefined,
    abandoned: AbortSignal,
  ): Promise<Arrival<T>> {
    const watch: Watch = {
      records: this.#records,
      mutex: this.#mutex,
      key,
      pollInterval: this.#pollInterval,
      abandoned,
    };
    let told = false;
    for (;;) {
      const before = await this.#records.latest(key);
      const led = await this.#mutex.acquire(
        key,
        (lease) => this.#lead(key, work, lease),
        { mode: skipIfBusy, signal: abandoned },
      );
      if (led.acquired) return { value: led.value, followed: false };
      const id = await findFlight(watch, before);
      if (id === undefined) continue;
      if (!told) onJoin?.();
      told = true;
      const followed = await follow(watch, id);
      if (followed.followed)
        return { value: this.#parse(followed.value), followed: true };
    }
  }

  async #lead(
    key: string,
    work: (lease: Lease) => Promise<T>,
    lease: Lease,
  ): Promise<T> {
    const id = await this.#records.begin(key);
    let value: unknown;
    try {
      // A value that JSON cannot carry fails the flight: no joiner could read it.
      value = encode(await work(lease));
    } catch (error) {
      await this.#records.finish(key, id, {
        status: 'failed',
        error: recordedError(error),
      });
      throw error;
    }
    // Another holder may have run the work too: the value is not the outcome of one flight.
    if (lease.signal.aborted) {
      await this.#records.finish(key, id, { status: 'interrupted' });
      throw lease.signal.reason;
    }
    // A throw here rejects the leader, although the work did its side effects.
    await this.#records.finish(key, id, { status: 'succeeded', value });
    return this.#parse(value);
  }
}
