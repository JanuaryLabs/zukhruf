import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-missing-console.ts';

const reported = [{ messageId: 'matched' }];

test('no-missing-console', () => {
  typescriptRuleTester().run('no-missing-console', rule, {
    valid: [
      { code: `console.log('ready');` },
      { code: `console.table(rows); console.group('a'); console.groupEnd();` },
      { code: `console.time('t'); console.timeEnd('t'); console.count();` },
      { code: `console['warn']('slow');` },
      { code: `logger.dir(value);` },
    ],
    invalid: [
      { code: `console.dir(value);`, errors: reported },
      { code: `console.timeLog('t');`, errors: reported },
      { code: `console.clear();`, errors: reported },
      { code: `const show = console.dirxml;`, errors: reported },
      { code: `console['profile']();`, errors: reported },
      { code: `console[level](message);`, errors: reported },
    ],
  });
});
