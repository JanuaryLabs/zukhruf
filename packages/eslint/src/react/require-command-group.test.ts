import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './require-command-group.ts';

const kit =
  "import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@zukhruf/shadcn';\n";

test('require-command-group', () => {
  typescriptRuleTester().run('require-command-group', rule, {
    valid: [
      {
        code: `${kit}const x = <Command><CommandInput /><CommandList><CommandEmpty>No results.</CommandEmpty><CommandGroup heading="Units"><CommandItem value="mg">mg</CommandItem><CommandItem value="g">g</CommandItem></CommandGroup><CommandSeparator /><CommandGroup><CommandItem value="ml">ml</CommandItem></CommandGroup></CommandList></Command>;`,
        filename: 'a.tsx',
      },
      {
        code: `${kit}const x = <CommandList><CommandGroup>{units.map((unit) => <CommandItem key={unit} value={unit}>{unit}</CommandItem>)}</CommandGroup></CommandList>;`,
        filename: 'a.tsx',
      },
      {
        code: `${kit}const x = <CommandList><CommandGroup>{units.map((unit) => { return <CommandItem key={unit} value={unit}>{unit}</CommandItem>; })}</CommandGroup></CommandList>;`,
        filename: 'a.tsx',
      },
      // The items come from the caller; the rule cannot see where they sit.
      {
        code: `${kit}const x = <CommandList>{children}</CommandList>;`,
        filename: 'a.tsx',
      },
      // A Command of another library is not the kit's.
      {
        code: 'import { CommandList, CommandItem } from \'cmdk\';\nconst x = <CommandList><CommandItem value="mg">mg</CommandItem></CommandList>;',
        filename: 'a.tsx',
      },
      {
        code: "import { CommandList } from '@zukhruf/shadcn';\nimport { CommandItem } from './command-item';\nconst x = <CommandList><CommandItem value=\"mg\">mg</CommandItem></CommandList>;",
        filename: 'a.tsx',
      },
    ],
    invalid: [
      {
        code: `${kit}const x = <CommandList>{units.map((unit) => <CommandItem key={unit} value={unit}>{unit}</CommandItem>)}</CommandList>;`,
        filename: 'a.tsx',
        errors: [{ messageId: 'ungrouped' }],
      },
      {
        code: `${kit}const x = <CommandList>{units?.map((unit) => <CommandItem key={unit} value={unit}>{unit}</CommandItem>)}</CommandList>;`,
        filename: 'a.tsx',
        errors: [{ messageId: 'ungrouped' }],
      },
      {
        code: `${kit}const x = <CommandList><CommandEmpty>No results.</CommandEmpty><CommandItem value="">None</CommandItem>{children}</CommandList>;`,
        filename: 'a.tsx',
        errors: [{ messageId: 'ungrouped' }],
      },
      {
        code: 'import { CommandList as List, CommandItem as Item } from \'@zukhruf/shadcn\';\nconst x = <List>{open ? <Item value="mg">mg</Item> : null}</List>;',
        filename: 'a.tsx',
        errors: [{ messageId: 'ungrouped' }],
      },
      {
        code: 'import * as ui from \'@zukhruf/shadcn\';\nconst x = <ui.CommandList><><ui.CommandItem value="mg">mg</ui.CommandItem></></ui.CommandList>;',
        filename: 'a.tsx',
        errors: [{ messageId: 'ungrouped' }],
      },
    ],
  });
});
