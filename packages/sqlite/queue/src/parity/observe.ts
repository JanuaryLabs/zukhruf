import { ParityRun } from './backends.ts';

// Turns what a backend returns into a plain observation both backends can be
// compared on: Dates become milliseconds since the shared clock's start, and
// a job's AbortSignal (a live object no serializer compares) is left out.
export class Observe {
  static readonly #origin = Date.parse(ParityRun.start);

  static job(job: object): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(job)
        .filter(([key]) => key !== 'signal')
        .map(([key, value]) => [
          key,
          value instanceof Date ? value.getTime() - Observe.#origin : value,
        ]),
    );
  }
}
