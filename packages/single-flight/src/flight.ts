import { Latch, untilAborted } from '@zukhruf/async';

/** One run of the work for a key in this process. Every caller that joins it gets how it ended. */
export class Flight<T> {
  /** Opens with the outcome of the work. An error is data here, so the latch never rejects; each caller throws it. */
  readonly #ended = new Latch<PromiseSettledResult<Awaited<T>>>();
  readonly #abandoned = new AbortController();
  /** The callers that wait for the flight now. */
  #waiting = 0;

  constructor(work: (abandoned: AbortSignal) => Promise<T>) {
    void Promise.allSettled([Promise.try(work, this.#abandoned.signal)]).then(
      ([outcome]) => this.#ended.open(outcome),
    );
  }

  /** The outcome of the work, once it ended. Never rejects. */
  get ended(): Promise<PromiseSettledResult<Awaited<T>>> {
    return this.#ended.wait();
  }

  /** Aborts when every caller cancelled its wait before the flight ended. */
  get abandoned(): AbortSignal {
    return this.#abandoned.signal;
  }

  /** Waits for the flight for one caller, until it ends or `signal` aborts. */
  async wait(signal: AbortSignal | undefined): Promise<T> {
    this.#waiting++;
    const leave = () => {
      this.#waiting--;
      if (this.#waiting === 0) this.#abandoned.abort();
    };
    signal?.addEventListener('abort', leave, { once: true });
    void this.#ended
      .wait()
      .then(() => signal?.removeEventListener('abort', leave));
    const outcome = await untilAborted(this.#ended.wait(), signal);
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  }
}
