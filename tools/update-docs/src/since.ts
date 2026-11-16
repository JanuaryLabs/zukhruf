import { UsageError } from './errors.ts';

type Window =
  | { readonly kind: 'ever' }
  | { readonly kind: 'from'; readonly instant: Temporal.Instant };

/** The start of the time a read covers: all time, or from an instant on. */
export class Since {
  static readonly ever = new Since({ kind: 'ever' });

  readonly #window: Window;

  private constructor(window: Window) {
    this.#window = window;
  }

  static from(instant: Temporal.Instant): Since {
    return new Since({ kind: 'from', instant });
  }

  /** The earliest of several starts, for one read that serves them all. */
  static earliest(starts: readonly Since[]): Since {
    let earliest: Temporal.Instant | 'none' = 'none';
    for (const start of starts) {
      if (start.#window.kind === 'ever') {
        return Since.ever;
      }
      if (
        earliest === 'none' ||
        Temporal.Instant.compare(start.#window.instant, earliest) < 0
      ) {
        earliest = start.#window.instant;
      }
    }
    return earliest === 'none' ? Since.ever : Since.from(earliest);
  }

  includes(instant: Temporal.Instant): boolean {
    return (
      this.#window.kind === 'ever' ||
      Temporal.Instant.compare(instant, this.#window.instant) >= 0
    );
  }

  /** A timestamp that does not parse is outside every window but "ever". */
  includesText(timestamp: string): boolean {
    if (this.#window.kind === 'ever') {
      return true;
    }
    try {
      return this.includes(Temporal.Instant.from(timestamp));
    } catch (error) {
      if (error instanceof RangeError) {
        return false;
      }
      throw error;
    }
  }

  gitArgs(): string[] {
    return this.#window.kind === 'ever'
      ? []
      : [`--since=${this.#window.instant.toString()}`];
  }

  /** Consumer commits are read only when a window bounds them. */
  get bounded(): boolean {
    return this.#window.kind === 'from';
  }
}

/** Parses an ISO 8601 instant given on the command line. */
export function parseInstant(text: string, option: string): Temporal.Instant {
  try {
    return Temporal.Instant.from(text);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new UsageError(
        `${option} takes an ISO 8601 instant with an offset, such as 2026-11-16T09:00:00Z; got "${text}"`,
      );
    }
    throw error;
  }
}
