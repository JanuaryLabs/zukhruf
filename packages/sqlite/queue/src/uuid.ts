import { DatabaseError } from './database-error.ts';

// Postgres's uuid input, which pg-boss binds every job id through: 32 hex
// digits in either case, a hyphen allowed after any group of four but the
// last, optionally in braces, printed lower case as 8-4-4-4-12; any other
// text is 22P02 (https://www.postgresql.org/docs/current/datatype-uuid.html).
export class Uuid {
  static readonly #input =
    /^(?:\{([0-9a-f]{4}(?:-?[0-9a-f]{4}){7})\}|([0-9a-f]{4}(?:-?[0-9a-f]{4}){7}))$/i;

  static canonical(text: string): string {
    const match = Uuid.#input.exec(text);
    const digits = (match?.[1] ?? match?.[2])
      ?.replaceAll('-', '')
      .toLowerCase();
    if (digits === undefined) {
      throw new DatabaseError(
        `invalid input syntax for type uuid: "${text}"`,
        '22P02',
      );
    }
    return [
      digits.slice(0, 8),
      digits.slice(8, 12),
      digits.slice(12, 16),
      digits.slice(16, 20),
      digits.slice(20),
    ].join('-');
  }

  // send()'s id, which pg-boss's insert reads out of its JSON payload
  // (node_modules/pg-boss/dist/plans.js:2303): a string as it is, anything
  // else as its JSON text.
  static fromPayload(value: unknown): string {
    return Uuid.canonical(
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  }

  // findJobs()'s id, bound as a parameter (plans.js:3694): null is SQL NULL,
  // which matches no job.
  static parameter(value: unknown): string | null {
    return value === null ? null : Uuid.canonical(String(value));
  }
}
