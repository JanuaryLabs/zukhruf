import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-compact-notation.ts';

const reported = [
  {
    message:
      "Hermes on iOS ignores notation: 'compact' and compactDisplay, and formats the full number. Build the short form yourself.",
  },
];

test('no-compact-notation', () => {
  typescriptRuleTester().run('no-compact-notation', rule, {
    valid: [
      { code: `new Intl.NumberFormat('en', { notation: 'standard' });` },
      { code: `new Intl.NumberFormat('en').format(44000);` },
      // Not the options of Intl.NumberFormat.
      { code: `const chart = { notation: 'compact' };` },
      { code: `chart.render({ notation: 'compact' });` },
      { code: `new Intl.DateTimeFormat('en', { notation: 'compact' });` },
    ],
    invalid: [
      {
        code: `new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });`,
        errors: reported,
      },
      {
        code: `Intl.NumberFormat('en', { notation: 'compact' });`,
        errors: reported,
      },
      {
        code: `new Intl.NumberFormat('en', { 'notation': 'compact' });`,
        errors: reported,
      },
      {
        code: `new Intl.NumberFormat('en', { compactDisplay: 'short' });`,
        errors: reported,
      },
    ],
  });
});
