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
    forms: [
      'md:h-screen',
      '[&>*]:h-screen',
      '!h-screen',
      'h-screen!',
      'min-h-screen',
      'max-h-screen',
    ],
  },
  {
    name: 'no-arbitrary-z-index',
    rule: noArbitraryZIndex,
    banned: 'z-[60]',
    allowed: 'z-50',
    forms: ['md:z-[60]', '!z-[60]', '-z-[5]'],
  },
  {
    name: 'no-will-change',
    rule: noWillChange,
    banned: 'will-change-transform',
    allowed: 'transform-gpu',
    forms: ['hover:will-change-transform', '!will-change-transform'],
  },
];

test('no-h-screen ignores a module name that ends in h-screen', () => {
  typescriptRuleTester().run('no-h-screen', noHScreen, {
    valid: [
      { code: "import 'expo-splash-screen';" },
      { code: 'const x = `expo-splash-screen ${y}`;' },
    ],
    invalid: [],
  });
});

test('no-h-screen and no-will-change ignore their own rule names', () => {
  typescriptRuleTester().run('no-h-screen', noHScreen, {
    valid: [
      { code: "export default { rules: { 'zukhruf/no-h-screen': 'off' } };" },
    ],
    invalid: [],
  });
  typescriptRuleTester().run('no-will-change', noWillChange, {
    valid: [
      {
        code: "export default { rules: { 'zukhruf/no-will-change': 'off' } };",
      },
      { code: 'const rule = `zukhruf/no-will-change ${level}`;' },
    ],
    invalid: [],
  });
});

for (const { name, rule, banned, forms } of cases) {
  test(`${name} reports its class behind a variant, a modifier or as an object key`, () => {
    typescriptRuleTester().run(name, rule, {
      valid: [],
      invalid: [
        ...forms.flatMap((form) => [
          {
            code: `const x = cn('flex', '${form}');`,
            errors: [{ messageId: 'matched' }],
          },
          {
            code: 'const x = `flex ' + form + ' ${extra}`;',
            errors: [{ messageId: 'matched' }],
          },
          {
            code: 'const x = `flex\n' + form + '\n${extra}`;',
            errors: [{ messageId: 'matched' }],
          },
        ]),
        {
          code: `const x = cn({ '${banned}': full });`,
          errors: [{ messageId: 'matched' }],
        },
      ],
    });
  });
}

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
