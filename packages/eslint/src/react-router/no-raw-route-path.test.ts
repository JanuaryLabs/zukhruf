import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-raw-route-path.ts';

test('no-raw-route-path', () => {
  typescriptRuleTester().run('no-raw-route-path', rule, {
    valid: [
      { code: `const x = <Link to={href('/settings')} />;` },
      { code: `navigate(href('/settings'));` },
      { code: `navigate(-1);` },
      // A member callee is a browser call, not the router's.
      { code: `window.location.replace('/');` },
    ],
    invalid: [
      {
        code: `const x = <Link to="/settings" />;`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `const x = <Link to={'/settings'} />;`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: 'const x = <Link to={`/spaces/${id}`} />;',
        errors: [{ messageId: 'matched' }],
      },
      { code: `navigate('/home');`, errors: [{ messageId: 'matched' }] },
      {
        code: 'throw redirect(`/login?next=${next}`);',
        errors: [{ messageId: 'matched' }],
      },
    ],
  });
});
