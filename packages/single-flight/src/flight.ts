import { untilAborted } from '@zukhruf/async';

/** One run of the work for a key in this process. Every caller that joins it gets how it ended. */
export class Flight<T> {
  readonly #ended = Promise.withResolvers<T>();
  readonly #abandoned = new AbortController();
  /** The callers that wait for the flight now. */
  #waiting = 0;

  constructor(work: (abandoned: AbortSignal) => Promise<T>) {
    Promise.try(work, this.#abandoned.signal).then(
      this.#ended.resolve,
      this.#ended.reject,
    );
  }

  /** Settles as the work settled. */
  get ended(): Promise<T> {
    return this.#ended.promise;
  }

  /** Aborts when every caller cancelled its wait before the flight ended. */
  get abandoned(): AbortSignal {
    return this.#abandoned.signal;
  }

  /** Waits for the flight for one caller, until it ends or `signal` aborts. */
  wait(signal: AbortSignal | undefined): Promise<T> {
    this.#waiting++;
    const leave = () => {
      this.#waiting--;
      if (this.#waiting === 0) this.#abandoned.abort();
    };
    signal?.addEventListener('abort', leave, { once: true });
    const stopListening = () => signal?.removeEventListener('abort', leave);
    this.#ended.promise.then(stopListening, stopListening);
    return untilAborted(this.#ended.promise, signal);
  }
}
