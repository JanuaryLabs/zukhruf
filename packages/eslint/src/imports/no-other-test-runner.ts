import { importBanRule } from '../authoring/import-ban.ts';

export default importBanRule({
  description:
    'Disallow test runners other than node:test, and Vitest in a Vite app',
  packages: [
    'jest',
    '@jest/globals',
    'mocha',
    'jasmine',
    'ava',
    'tap',
    'tape',
    'uvu',
  ],
  message: 'Use node:test, or Vitest in a Vite app.',
});
