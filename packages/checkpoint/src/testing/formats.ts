import type { Format } from '../index.ts';

/** A position of the tests: a number, of version 1. */
export const position: Format<number> = {
  version: 1,
  encode: (value) => value,
  decode: (version, json) => {
    if (version !== 1 || typeof json !== 'number')
      throw new TypeError(`Not a position of version 1: ${version}`);
    return json;
  },
};

/** A map state value of the tests: a text, of version 1. */
export const text: Format<string> = {
  version: 1,
  encode: (value) => value,
  decode: (version, json) => {
    if (version !== 1 || typeof json !== 'string')
      throw new TypeError(`Not a text of version 1: ${version}`);
    return json;
  },
};
