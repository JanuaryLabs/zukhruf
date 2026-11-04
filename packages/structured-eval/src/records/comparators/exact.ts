import { isDeepStrictEqual } from 'node:util';

import type { Comparator } from '../comparator.ts';

export class Exact implements Comparator {
  agrees(stated: unknown, expected: unknown): boolean {
    return isDeepStrictEqual(stated, expected);
  }
}
