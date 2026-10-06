import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-internal-anchor.ts';

test('no-internal-anchor', () => {
  typescriptRuleTester().run('no-internal-anchor', rule, {
    valid: [
      { code: `const x = <a href="https://example.com">x</a>;` },
      { code: `const x = <a href="//cdn.example.com/a.js">x</a>;` },
      { code: `const x = <a href="#top">x</a>;` },
      { code: `const x = <Link to={href('/about')}>x</Link>;` },
    ],
    invalid: [
      {
        code: `const x = <a href="/about">x</a>;`,
        errors: [{ messageId: 'matched' }],
      },
    ],
  });
});
