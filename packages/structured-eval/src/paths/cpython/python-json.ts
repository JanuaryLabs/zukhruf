import { printParseErrorCode, visit } from 'jsonc-parser';

import type { JsonData } from '../json-value.ts';

// json.loads of CPython: each dict a Map in the order of its keys (a repeated
// key keeps its first place and its last value), each number with a `.`, `e`
// or `E` a float and any other an int (a bigint, exact), and the NaN,
// Infinity and -Infinity tokens of Python's json module. A text that is not
// JSON throws a SyntaxError: comments and trailing commas too. Copied from
// @zukhruf/mteb jsonLoadsInOrder (docs/copied-code.md), with the ints.
export function loadsJson(text: string): JsonData {
  const tokens = pythonTokens(text);
  const containers: (JsonData[] | Map<string, JsonData>)[] = [];
  let root: JsonData | undefined;
  let key = '';
  const add = (value: JsonData) => {
    const parent = containers.at(-1);
    if (parent === undefined) root = value;
    else if (Array.isArray(parent)) parent.push(value);
    else parent.set(key, value);
  };
  visit(
    tokens.json,
    {
      onObjectBegin: () => {
        const object = new Map<string, JsonData>();
        add(object);
        containers.push(object);
      },
      onObjectProperty: (property: string) => {
        tokens.key(property);
        key = property;
      },
      onObjectEnd: () => {
        containers.pop();
      },
      onArrayBegin: () => {
        const array: JsonData[] = [];
        add(array);
        containers.push(array);
      },
      onArrayEnd: () => {
        containers.pop();
      },
      onLiteralValue: (
        value: null | boolean | number | string,
        offset: number,
        length: number,
      ) => {
        if (typeof value !== 'number') {
          add(tokens.number(value));
          return;
        }
        const literal = tokens.json.slice(offset, offset + length);
        add(/[.eE]/.test(literal) ? value : BigInt(literal));
      },
      onError: (error, offset) => {
        throw new SyntaxError(
          `${printParseErrorCode(error)} at position ${offset} of the JSON text.`,
        );
      },
    },
    { disallowComments: true },
  );
  if (root === undefined) throw new SyntaxError('The JSON text has no value.');
  return root;
}

// Python's json module writes NaN, Infinity and -Infinity as bare tokens,
// which JSON does not have. json is the text with each token outside a string
// as a string that starts with a random marker; number gives the number of
// such a string, and any other value as it is. The json module reads the
// tokens only as values (_scan_once, Lib/json/scanner.py); a key must start
// with '"' (JSONObject, Lib/json/decoder.py), so key throws for a token.
function pythonTokens(text: string): {
  readonly json: string;
  readonly number: <T>(value: T) => T | number;
  readonly key: (name: string) => void;
} {
  const marker = `${crypto.randomUUID()}:`;
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const end = stringEnd(text, index);
      out += text.slice(index, end);
      index = end;
      continue;
    }
    const token = ['-Infinity', 'Infinity', 'NaN'].find((candidate) =>
      text.startsWith(candidate, index),
    );
    if (token !== undefined) {
      out += JSON.stringify(marker + token);
      index += token.length;
      continue;
    }
    out += char;
    index++;
  }
  const numbers = [
    [`${marker}NaN`, NaN],
    [`${marker}Infinity`, Infinity],
    [`${marker}-Infinity`, -Infinity],
  ] as const;
  return {
    json: out,
    number: (value) => {
      for (const [token, number] of numbers) if (value === token) return number;
      return value;
    },
    key: (name) => {
      if (numbers.some(([token]) => token === name))
        throw new SyntaxError(
          'Expecting property name enclosed in double quotes',
        );
    },
  };
}

// The index after the closing quote of the string that starts at start.
function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') index += 2;
    else if (text[index] === '"') return index + 1;
    else index++;
  }
  return text.length;
}
