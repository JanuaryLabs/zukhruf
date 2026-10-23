import { DatabaseError } from './database-error.ts';

// Postgres jsonb containment (`@>`), which pg-boss's findJobs uses for its
// `data` filter (node_modules/pg-boss/dist/plans.js:3702). Rules from
// https://www.postgresql.org/docs/current/datatype-json.html#JSON-CONTAINMENT:
// an object contains each key of the needle recursively, an array contains
// each needle element somewhere (order and duplicates ignored), and scalars
// must be equal. Postgres's one top-level exception, an array containing a
// bare scalar, cannot arise: findJobs's `data` is always an object.
export class Jsonb {
  static contains(haystack: unknown, needle: unknown): boolean {
    if (Array.isArray(needle)) {
      return (
        Array.isArray(haystack) &&
        needle.every((element) =>
          haystack.some((candidate) => Jsonb.contains(candidate, element)),
        )
      );
    }
    if (Jsonb.#isObject(needle)) {
      if (!Jsonb.#isObject(haystack)) {
        return false;
      }
      const fields = new Map(Object.entries(haystack));
      return Object.entries(needle).every(
        ([key, value]) =>
          fields.has(key) && Jsonb.contains(fields.get(key), value),
      );
    }
    return haystack === needle;
  }

  // The JSON text a jsonb column stores for a value bound as a query
  // parameter. pg-boss's drivers pass a string through as JSON text and send
  // anything else as JSON (node_modules/pg/lib/utils.js:79, 92); PGlite's
  // json serializer writes a bigint as its string (@electric-sql/pglite
  // 0.5.8 src/types.ts:106-114). The text travels as UTF-8, a raw lone
  // surrogate as U+FFFD, as node:sqlite binds it too. Postgres's jsonb input
  // then rejects text that is not JSON and the first escape it cannot store.
  static parameter(value: unknown): string {
    const serialized: string | undefined =
      typeof value === 'string'
        ? value
        : JSON.stringify(value, (_, item: unknown) =>
            typeof item === 'bigint' ? item.toString() : item,
          );
    if (serialized === undefined) {
      throw new DatabaseError('invalid input syntax for type json', '22P02');
    }
    try {
      JSON.parse(serialized);
    } catch {
      throw new DatabaseError('invalid input syntax for type json', '22P02');
    }
    Jsonb.assertEscapes(serialized);
    return serialized;
  }

  // Postgres's JSON lexer reads the \u escapes in text order and refuses the
  // first one a stored value cannot hold: \u0000 (22P05), or a surrogate
  // escape that is not a high one immediately followed by a low one (22P02).
  static assertEscapes(text: string): void {
    const refused = Jsonb.#refusedEscape(text);
    if (refused !== undefined) {
      throw refused;
    }
  }

  static #refusedEscape(text: string): DatabaseError | undefined {
    const invalid = new DatabaseError(
      'invalid input syntax for type json',
      '22P02',
    );
    let pairEndsAt: number | undefined;
    for (const escape of text.matchAll(/\\(?:u([0-9a-fA-F]{4})|[^u])/g)) {
      const code =
        escape[1] === undefined ? undefined : Number.parseInt(escape[1], 16);
      const low = code !== undefined && code >= 0xdc00 && code <= 0xdfff;
      if (pairEndsAt !== undefined) {
        if (!low || escape.index !== pairEndsAt) {
          return invalid;
        }
        pairEndsAt = undefined;
        continue;
      }
      if (code === 0) {
        return new DatabaseError(
          'unsupported Unicode escape sequence',
          '22P05',
        );
      }
      if (low) {
        return invalid;
      }
      if (code !== undefined && code >= 0xd800 && code <= 0xdbff) {
        pairEndsAt = escape.index + escape[0].length;
      }
    }
    return pairEndsAt === undefined ? undefined : invalid;
  }

  static #isObject(value: unknown): value is object {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
