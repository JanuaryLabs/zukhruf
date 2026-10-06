import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-untyped-empty-json.ts';

test('no-untyped-empty-json', () => {
  typescriptRuleTester().run('no-untyped-empty-json', rule, {
    valid: [
      { code: `app.get('/', (c) => c.json([] satisfies Item[]));` },
      { code: `app.get('/', (c) => c.json(items));` },
      { code: `app.get('/', (c) => c.json({ items: [] }));` },
    ],
    invalid: [
      {
        code: `app.get('/', (c) => c.json([]));`,
        errors: [{ messageId: 'matched' }],
      },
    ],
  });
});
