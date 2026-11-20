import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-native-select.ts';

test('no-native-select', () => {
  typescriptRuleTester().run('no-native-select', rule, {
    valid: [
      {
        code: 'const x = <Select name="unit" items={items}><SelectTrigger><SelectValue /></SelectTrigger></Select>;',
        filename: 'a.tsx',
      },
      // Only the lowercase intrinsic is the native element.
      { code: 'const x = <SelectTrigger />;', filename: 'a.tsx' },
      { code: 'const props = { select: true };', filename: 'a.tsx' },
      { code: 'const select = (id: string) => id;', filename: 'a.tsx' },
      // A NativeSelect of another source is not the kit's.
      {
        code: "import { NativeSelect } from './native-select';",
        filename: 'a.tsx',
      },
      {
        code: "import { Select, SelectItem } from '@zukhruf/shadcn';",
        filename: 'a.tsx',
      },
    ],
    invalid: [
      {
        code: 'const x = <select name="unit"><option value="mg">mg</option></select>;',
        filename: 'a.tsx',
        errors: [{ messageId: 'matched' }],
      },
      {
        code: 'const x = <select multiple />;',
        filename: 'a.tsx',
        errors: [{ messageId: 'matched' }],
      },
      {
        code: "import { NativeSelect } from '@zukhruf/shadcn';",
        filename: 'a.tsx',
        errors: [{ messageId: 'matched' }],
      },
      {
        code: "import { NativeSelect as Picker } from '@zukhruf/shadcn';",
        filename: 'a.tsx',
        errors: [{ messageId: 'matched' }],
      },
      {
        code: "import { Button, NativeSelectOption, NativeSelectOptGroup } from '@zukhruf/shadcn';",
        filename: 'a.tsx',
        errors: [{ messageId: 'matched' }, { messageId: 'matched' }],
      },
      {
        code: "export { NativeSelect } from '@zukhruf/shadcn';",
        filename: 'a.tsx',
        errors: [{ messageId: 'matched' }],
      },
    ],
  });
});
