import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './require-combobox-popover-modal.ts';

const ruleTester = typescriptRuleTester();

// A <Popover> wrapping the canonical shadcn combobox (Command + CommandInput).
const combobox = (popoverOpenTag: string) =>
  `const x = (${popoverOpenTag}<PopoverContent><Command><CommandInput/></Command></PopoverContent></Popover>);`;

test('require-combobox-popover-modal', () => {
  ruleTester.run('require-combobox-popover-modal', rule, {
    valid: [
      { code: combobox('<Popover modal>'), filename: 'a.tsx' },
      { code: combobox('<Popover modal={true}>'), filename: 'a.tsx' },
      // A dynamic value is the author's explicit choice — not flagged.
      { code: combobox('<Popover modal={open}>'), filename: 'a.tsx' },
      // A spread could supply `modal` at runtime — too imprecise to flag.
      { code: combobox('<Popover {...rest}>'), filename: 'a.tsx' },
      // A <Popover> with no <Command> inside is not a combobox.
      {
        code: 'const x = (<Popover><PopoverContent>hi</PopoverContent></Popover>);',
        filename: 'a.tsx',
      },
    ],
    invalid: [
      {
        code: combobox('<Popover>'),
        filename: 'a.tsx',
        output: combobox('<Popover modal>'),
        errors: [{ messageId: 'requireModal' }],
      },
      {
        code: combobox('<Popover open={o} onOpenChange={s}>'),
        filename: 'a.tsx',
        output: combobox('<Popover modal open={o} onOpenChange={s}>'),
        errors: [{ messageId: 'requireModal' }],
      },
      {
        code: combobox('<Popover modal={false}>'),
        filename: 'a.tsx',
        errors: [{ messageId: 'noExplicitFalse' }],
      },
    ],
  });
});
