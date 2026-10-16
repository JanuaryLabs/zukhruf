import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-as-child.ts';

test('no-as-child', () => {
  typescriptRuleTester().run('no-as-child', rule, {
    valid: [
      {
        code: 'const x = <DialogTrigger render={<Button />}>Open</DialogTrigger>;',
        filename: 'a.tsx',
      },
      {
        code: 'const x = <MenuItem render={<div />} nativeButton={false} />;',
        filename: 'a.tsx',
      },
      // Only the JSX prop is Radix's API; an object key of that name is not.
      { code: 'const props = { asChild: true };', filename: 'a.tsx' },
    ],
    invalid: [
      {
        code: 'const x = <DialogTrigger asChild><Button>Open</Button></DialogTrigger>;',
        filename: 'a.tsx',
        errors: [{ messageId: 'matched' }],
      },
      {
        code: 'const x = <Slot asChild={false} />;',
        filename: 'a.tsx',
        errors: [{ messageId: 'matched' }],
      },
      {
        code: 'const x = <Tooltip.Trigger asChild={open}><a href="/" /></Tooltip.Trigger>;',
        filename: 'a.tsx',
        errors: [{ messageId: 'matched' }],
      },
    ],
  });
});
