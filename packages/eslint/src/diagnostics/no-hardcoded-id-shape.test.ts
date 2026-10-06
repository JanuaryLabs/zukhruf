import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-hardcoded-id-shape.ts';

test('no-hardcoded-id-shape', () => {
  typescriptRuleTester().run('no-hardcoded-id-shape', rule, {
    valid: [
      // The fix: anchor on the sentence the program prints, not the id format.
      {
        code: String.raw`const m = out.match(/created dashboard\s+(\S+)\s+\(building\)/);`,
      },
      { code: String.raw`const m = out.match(/created chat\s+(\S+)/);` },
      // Ordinary character classes that happen to be near a quantifier.
      { code: String.raw`const seg = /^[A-Za-z0-9_-]+$/;` },
      { code: String.raw`const hex = /^[0-9a-f]+$/i;` },
      // Short repeats are not an id shape.
      { code: String.raw`const pair = /[0-9a-f]{2}-[0-9a-f]{2}/;` },
      // A RegExp built from a non-literal cannot be inspected; do not guess.
      { code: 'const re = new RegExp(pattern);' },
      // Class-name-ish strings, not regexes.
      { code: `const cls = '[a-z0-9]{25}';` },
    ],
    invalid: [
      // A UUID shape matched against a cuid column.
      {
        code: String.raw`const m = out.match(/dashboard\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);`,
        errors: [{ messageId: 'idShape', data: { shape: 'uuid' } }],
      },
      // Uppercase hex variant.
      {
        code: String.raw`const re = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}/;`,
        errors: [{ messageId: 'idShape', data: { shape: 'uuid' } }],
      },
      // Shorthand digit class variant.
      {
        code: String.raw`const re = /[a-f\d]{8}-[a-f\d]{4}/;`,
        errors: [{ messageId: 'idShape', data: { shape: 'uuid' } }],
      },
      // cuid / cuid2 lengths.
      {
        code: String.raw`const re = /c[a-z0-9]{24}/;`,
        errors: [{ messageId: 'idShape', data: { shape: 'cuid' } }],
      },
      {
        code: String.raw`const re = /^[a-z0-9]{25}$/;`,
        errors: [{ messageId: 'idShape', data: { shape: 'cuid' } }],
      },
      {
        code: String.raw`const re = /[A-Z0-9]{20,32}/i;`,
        errors: [{ messageId: 'idShape', data: { shape: 'cuid' } }],
      },
      // Built through the RegExp constructor from a string literal.
      {
        code: `const re = new RegExp('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}');`,
        errors: [{ messageId: 'idShape', data: { shape: 'uuid' } }],
      },
      {
        code: `const re = RegExp('c[a-z0-9]{24}');`,
        errors: [{ messageId: 'idShape', data: { shape: 'cuid' } }],
      },
    ],
  });
});
