import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-native-control.ts';

const kitInput = "import { Input } from '@zukhruf/shadcn';\n";

test('no-native-control: select', () => {
  typescriptRuleTester().run('no-native-control', rule, {
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
        errors: [{ messageId: 'select' }],
      },
      {
        code: 'const x = <select multiple />;',
        filename: 'a.tsx',
        errors: [{ messageId: 'select' }],
      },
      {
        code: "import { NativeSelect } from '@zukhruf/shadcn';",
        filename: 'a.tsx',
        errors: [{ messageId: 'select' }],
      },
      {
        code: "import { NativeSelect as Picker } from '@zukhruf/shadcn';",
        filename: 'a.tsx',
        errors: [{ messageId: 'select' }],
      },
      {
        code: "import { Button, NativeSelectOption, NativeSelectOptGroup } from '@zukhruf/shadcn';",
        filename: 'a.tsx',
        errors: [{ messageId: 'select' }, { messageId: 'select' }],
      },
      {
        code: "export { NativeSelect } from '@zukhruf/shadcn';",
        filename: 'a.tsx',
        errors: [{ messageId: 'select' }],
      },
      {
        code: 'import * as ui from \'@zukhruf/shadcn\';\nconst x = <ui.NativeSelect name="unit" />;',
        filename: 'a.tsx',
        errors: [{ messageId: 'select' }],
      },
    ],
  });
});

test('no-native-control: input types', () => {
  typescriptRuleTester().run('no-native-control', rule, {
    valid: [
      // No widget of the kit for these types, or no widget at all.
      { code: 'const x = <input type="time" />;', filename: 'a.tsx' },
      { code: 'const x = <input type="file" />;', filename: 'a.tsx' },
      { code: 'const x = <input type="color" />;', filename: 'a.tsx' },
      { code: 'const x = <input type="hidden" />;', filename: 'a.tsx' },
      { code: 'const x = <input type="email" />;', filename: 'a.tsx' },
      { code: 'const x = <input name="q" />;', filename: 'a.tsx' },
      {
        code: `${kitInput}const x = <Input type="time" />;`,
        filename: 'a.tsx',
      },
      { code: `${kitInput}const x = <Input name="q" />;`, filename: 'a.tsx' },
      // A type that is not a literal is not read.
      { code: 'const x = <input type={t} />;', filename: 'a.tsx' },
      {
        code: `${kitInput}const x = <Input type={kind} />;`,
        filename: 'a.tsx',
      },
      // An Input of another source is not the kit's.
      {
        code: 'import { Input } from \'./input\';\nconst x = <Input type="date" />;',
        filename: 'a.tsx',
      },
      { code: 'const x = <Input type="checkbox" />;', filename: 'a.tsx' },
      // The kit's Checkbox is the fix.
      {
        code: 'import { Checkbox } from \'@zukhruf/shadcn\';\nconst x = <Checkbox name="agree" />;',
        filename: 'a.tsx',
      },
      {
        code: `${kitInput}const x = <Input type={multiple ? 'text' : 'email'} />;`,
        filename: 'a.tsx',
      },
    ],
    invalid: [
      {
        code: 'const x = <input type="date" name="born" />;',
        filename: 'a.tsx',
        errors: [
          {
            // The date message; its `{{` is not read as a placeholder.
            message: /`disabled=\{\{ after: today \}\}`/,
          },
        ],
      },
      {
        code: "const x = <input type={'datetime-local'} />;",
        filename: 'a.tsx',
        errors: [{ messageId: 'date' }],
      },
      {
        code: 'const x = <input type="Date" />;',
        filename: 'a.tsx',
        errors: [{ messageId: 'date' }],
      },
      {
        code: `${kitInput}const x = <Input type="date" />;`,
        filename: 'a.tsx',
        errors: [{ messageId: 'date' }],
      },
      {
        code: 'import { Input as Field } from \'@zukhruf/shadcn\';\nconst x = <Field type="date" />;',
        filename: 'a.tsx',
        errors: [{ messageId: 'date' }],
      },
      // The kit's other inputs render its Input with the type they are given.
      {
        code: 'import { InputGroupInput as Control } from \'@zukhruf/shadcn\';\nconst x = <Control type="date" />;',
        filename: 'a.tsx',
        errors: [{ messageId: 'date' }],
      },
      {
        code: 'import { SidebarInput } from \'@zukhruf/shadcn\';\nconst x = <SidebarInput type="checkbox" />;',
        filename: 'a.tsx',
        errors: [{ messageId: 'checkbox' }],
      },
      {
        code: 'import * as ui from \'@zukhruf/shadcn\';\nconst x = <ui.Input type="date" />;',
        filename: 'a.tsx',
        errors: [{ messageId: 'date' }],
      },
      {
        code: 'const x = <input type="checkbox" name="agree" />;',
        filename: 'a.tsx',
        errors: [{ messageId: 'checkbox' }],
      },
      {
        code: `${kitInput}const x = <Input type="checkbox" />;`,
        filename: 'a.tsx',
        errors: [{ messageId: 'checkbox' }],
      },
      {
        code: 'const x = <input type="radio" name="sex" value="f" />;',
        filename: 'a.tsx',
        errors: [{ messageId: 'radio' }],
      },
      {
        code: `${kitInput}const x = <Input type={\`radio\`} />;`,
        filename: 'a.tsx',
        errors: [{ messageId: 'radio' }],
      },
      {
        code: 'const x = <input type="range" min={0} max={10} />;',
        filename: 'a.tsx',
        errors: [{ messageId: 'range' }],
      },
      // A conditional reports each control it can make, once.
      {
        code: "const x = <input type={multiple ? 'checkbox' : 'radio'} />;",
        filename: 'a.tsx',
        errors: [{ messageId: 'checkbox' }, { messageId: 'radio' }],
      },
      {
        code: "const x = <input type={wide ? 'date' : 'datetime-local'} />;",
        filename: 'a.tsx',
        errors: [{ messageId: 'date' }],
      },
      {
        code: "const x = <input type={on ? 'checkbox' : kind} />;",
        filename: 'a.tsx',
        errors: [{ messageId: 'checkbox' }],
      },
    ],
  });
});
