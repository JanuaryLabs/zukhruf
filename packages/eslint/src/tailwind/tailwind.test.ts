import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import noArbitraryZIndex from './no-arbitrary-z-index.ts';
import noHScreen from './no-h-screen.ts';
import noWillChange from './no-will-change.ts';

const cases = [
  {
    name: 'no-h-screen',
    rule: noHScreen,
    banned: 'h-screen',
    allowed: 'h-dvh',
  },
  {
    name: 'no-arbitrary-z-index',
    rule: noArbitraryZIndex,
    banned: 'z-[60]',
    allowed: 'z-50',
  },
  {
    name: 'no-will-change',
    rule: noWillChange,
    banned: 'will-change-transform',
    allowed: 'transform-gpu',
  },
];

for (const { name, rule, banned, allowed } of cases) {
  test(name, () => {
    typescriptRuleTester().run(name, rule, {
      valid: [
        { code: `const x = <div className="flex ${allowed}" />;` },
        { code: `const x = cn('flex', '${allowed}');` },
      ],
      invalid: [
        {
          code: `const x = <div className="flex ${banned}" />;`,
          errors: [{ messageId: 'matched' }],
        },
        {
          code: `const x = cn('flex', '${banned}');`,
          errors: [{ messageId: 'matched' }],
        },
        {
          code: 'const x = `flex ' + banned + ' ${extra}`;',
          errors: [{ messageId: 'matched' }],
        },
      ],
    });
  });
}
