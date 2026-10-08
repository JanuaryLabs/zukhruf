import { Flight } from './flight.ts';

export interface RunOptions {
  /** Called once, before this caller starts to wait for a flight that another caller started. */
  onJoin?: (() => void) | undefined;
  /** Stops the wait of this caller only, which then rejects with `signal.reason`. The flight runs on. */
  signal?: AbortSignal | undefined;
}

/** What a caller gets: the value of the flight, and whether the caller joined a flight that another caller started. */
export interface FlightValue<T> {
  readonly value: T;
  readonly joined: boolean;
}

/** Callers of one key in this process share the flight in progress. */
export class SingleFlight<T> {
  /** Only the flights in progress: a flight that ended leaves, so the next call starts a new one. */
  readonly #flights = new Map<string, Flight<T>>();

  /**
   * Runs `work` for `key`, or joins the flight of `key` in progress. `work`
   * gets a signal that aborts only when every caller of the flight cancelled:
   * work that can stop early may read it. Work that ignores it runs on, and
   * the next call starts a new flight either way.
   */
  async run(
    key: string,
    work: (abandoned: AbortSignal) => Promise<T>,
    { onJoin, signal }: RunOptions = {},
  ): Promise<FlightValue<T>> {
    // A caller that already cancelled neither starts nor joins a flight.
    signal?.throwIfAborted();
    // No await before the flight is in the map: a second caller must find it.
    const inProgress = this.#flights.get(key);
    const flight = inProgress ?? this.#start(key, work);
    const joined = inProgress !== undefined;
    if (joined) onJoin?.();
    // The signal stops only this caller's wait. The work never sees it, so
    // the other callers still get the value.
    return { value: await flight.wait(signal), joined };
  }

  #start(key: string, work: (abandoned: AbortSignal) => Promise<T>) {
    const flight = new Flight(work);
    this.#flights.set(key, flight);
    const leave = () => {
      if (this.#flights.get(key) === flight) this.#flights.delete(key);
    };
    flight.ended.then(leave, leave);
    // In the same step as the abort, so no caller joins a flight that nobody
    // waits for (Go issue 22724: a new lookup joined a cancelled one).
    flight.abandoned.addEventListener('abort', leave, { once: true });
    return flight;
  }
}
