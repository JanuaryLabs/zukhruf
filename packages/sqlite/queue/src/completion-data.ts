import { serializeError } from 'serialize-error';

import { Jsonb } from './jsonb.ts';

export class CompletionData {
  // What complete() and fail() bind as their jsonb parameter. The drivers send
  // null and undefined as SQL NULL.
  static serialize(data: unknown): string | null {
    const output = CompletionData.#map(data);
    return output === null || output === undefined
      ? null
      : Jsonb.parameter(output);
  }

  // A group's outputs bound as one JSON recordset (node_modules/pg-boss/dist/
  // manager.js:412, 422, 447, 451; plans.js:2137, 2654, 2667): every output is
  // mapped before the payload is stringified, and each row's output is then
  // stored as the JSON value it is, so a mapped string stays a JSON string.
  // An output the payload leaves out or holds as JSON null is SQL NULL.
  static serializeAll(data: unknown[]): (string | null)[] {
    const outputs = data.map((item) => CompletionData.#map(item));
    const texts = outputs.map((output) => JSON.stringify(output));
    return texts.map((text) =>
      text === undefined || text === 'null' ? null : Jsonb.parameter(text),
    );
  }

  // pg-boss's mapCompletionDataArg (node_modules/pg-boss/dist/manager.js:
  // 1614-1622): what complete() and fail() store as a job's output. Nothing,
  // undefined and functions store null; an object that is not an array stores
  // as it is; anything else, arrays included, as { value }. serialize-error
  // turns an Error into { name, message, stack, ... } and an object with toJSON
  // into what toJSON returns.
  static #map(data: unknown): unknown {
    if (data === null || data === undefined || typeof data === 'function') {
      return null;
    }
    const result =
      typeof data === 'object' && !Array.isArray(data) ? data : { value: data };
    return serializeError(result);
  }
}
