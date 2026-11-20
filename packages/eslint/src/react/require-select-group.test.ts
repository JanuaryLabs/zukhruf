import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './require-select-group.ts';

const kit =
  "import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel } from '@zukhruf/shadcn';\n";

test('require-select-group', () => {
  typescriptRuleTester().run('require-select-group', rule, {
    valid: [
      {
        code: `${kit}const x = <SelectContent><SelectGroup><SelectItem value="mg">mg</SelectItem><SelectItem value="g">g</SelectItem></SelectGroup></SelectContent>;`,
        filename: 'a.tsx',
      },
      {
        code: `${kit}const x = <SelectContent><SelectGroup>{units.map((unit) => <SelectItem key={unit} value={unit}>{unit}</SelectItem>)}</SelectGroup></SelectContent>;`,
        filename: 'a.tsx',
      },
      {
        code: `${kit}const x = <SelectContent><SelectGroup><SelectLabel>Unit</SelectLabel>{units.map((unit) => { return <SelectItem key={unit} value={unit}>{unit}</SelectItem>; })}</SelectGroup></SelectContent>;`,
        filename: 'a.tsx',
      },
      // The items come from the caller; the rule cannot see where they sit.
      {
        code: `${kit}const x = <SelectContent>{children}</SelectContent>;`,
        filename: 'a.tsx',
      },
      // A Select of another library is not the kit's.
      {
        code: 'import { SelectContent, SelectItem } from \'@radix-ui/react-select\';\nconst x = <SelectContent><SelectItem value="mg">mg</SelectItem></SelectContent>;',
        filename: 'a.tsx',
      },
      {
        code: "import { SelectContent } from '@zukhruf/shadcn';\nimport { SelectItem } from './select-item';\nconst x = <SelectContent><SelectItem value=\"mg\">mg</SelectItem></SelectContent>;",
        filename: 'a.tsx',
      },
    ],
    invalid: [
      {
        code: `${kit}const x = <SelectContent>{units.map((unit) => <SelectItem key={unit} value={unit}>{unit}</SelectItem>)}</SelectContent>;`,
        filename: 'a.tsx',
        errors: [{ messageId: 'ungrouped' }],
      },
      {
        code: `${kit}const x = <SelectContent>{units?.map((unit) => <SelectItem key={unit} value={unit}>{unit}</SelectItem>)}</SelectContent>;`,
        filename: 'a.tsx',
        errors: [{ messageId: 'ungrouped' }],
      },
      {
        code: `${kit}const x = <SelectContent><SelectItem value="">None</SelectItem>{children}</SelectContent>;`,
        filename: 'a.tsx',
        errors: [{ messageId: 'ungrouped' }],
      },
      {
        code: 'import { SelectContent as Content, SelectItem as Item } from \'@zukhruf/shadcn\';\nconst x = <Content>{open && <Item value="mg">mg</Item>}</Content>;',
        filename: 'a.tsx',
        errors: [{ messageId: 'ungrouped' }],
      },
      {
        code: 'import * as ui from \'@zukhruf/shadcn\';\nconst x = <ui.SelectContent><><ui.SelectItem value="mg">mg</ui.SelectItem></></ui.SelectContent>;',
        filename: 'a.tsx',
        errors: [{ messageId: 'ungrouped' }],
      },
    ],
  });
});
