import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import { selectorRule } from './selector-rule.ts';

test('selectorRule reports a message that holds a JSX object literal as written', () => {
  const message =
    "Pass the labels: `<Select items={{ mg: 'Milligram' }}>`, `style={{color: 'red'}}` or `{{{ a }}}`.";
  const rule = selectorRule({
    description: 'Disallow `<select>`',
    selectors: ["JSXOpeningElement[name.name='select']"],
    message,
  });
  typescriptRuleTester().run('selector-rule', rule, {
    valid: [],
    invalid: [
      // RuleTester fails a messageId report whose message keeps a placeholder.
      {
        code: 'const x = <select />;',
        filename: 'a.tsx',
        errors: [{ messageId: 'matched' }],
      },
      {
        code: 'const y = <select />;',
        filename: 'a.tsx',
        errors: [{ message }],
      },
    ],
  });
});
