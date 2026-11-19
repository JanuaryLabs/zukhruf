import { importBanRule } from '../authoring/import-ban.ts';

/** Test runners other than node:test and Vitest, by the package that a test imports. */
export const OTHER_TEST_RUNNERS = [
  'jest',
  '@jest/globals',
  'mocha',
  'jasmine',
  'ava',
  'tap',
  'tape',
  'uvu',
] as const;

export default importBanRule({
  description:
    'Disallow test runners other than node:test, and Vitest in a Vite app',
  packages: OTHER_TEST_RUNNERS,
  message: 'Use node:test, or Vitest in a Vite app.',
});
