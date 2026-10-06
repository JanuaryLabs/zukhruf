import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-single-env-read-wrapper.ts';

const ruleTester = typescriptRuleTester();

test('no-single-env-read-wrapper', () => {
  ruleTester.run('no-single-env-read-wrapper', rule, {
    valid: [
      // An async accessor returns a Promise — inlining would change the type.
      { code: `const f = async () => process.env.X;` },
      // A generator returns an iterator — not inlinable.
      { code: `function* g() { return process.env.X; }` },
      // Real logic (more than a literal fallback) is allowed.
      {
        code: `function h() { const v = process.env.X; doThing(); return v; }`,
      },
      { code: `function j() { return process.env.X ? 'a' : 'b'; }` },
      { code: `function k() { return process.env.X ?? getDefault(); }` },
    ],
    invalid: [
      // A bare passthrough.
      {
        code: `function getX() { return process.env.X; }`,
        errors: [{ messageId: 'trivialWrapper' }],
      },
      // A single literal coalesce is still a trivial accessor.
      {
        code: `function getSub() { return process.env.X || null; }`,
        errors: [{ messageId: 'trivialWrapper' }],
      },
      {
        code: `const getY = () => process.env.X ?? '';`,
        errors: [{ messageId: 'trivialWrapper' }],
      },
    ],
  });
});
