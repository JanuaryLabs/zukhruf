import { type Concept, enable } from '../concept.ts';
import { JSX } from '../files.ts';
import noAsChild from './no-as-child.ts';
import noDataSlotRestyle from './no-data-slot-restyle.ts';
import noNativeSelect from './no-native-select.ts';
import requireCommandGroup from './require-command-group.ts';
import requireSelectGroup from './require-select-group.ts';
import { SHADCN_SETTINGS } from './require-shadcn-config.ts';

const enabled = {
  'no-as-child': noAsChild,
  'no-native-select': noNativeSelect,
  'require-command-group': requireCommandGroup,
  'require-select-group': requireSelectGroup,
};

const rules = {
  ...enabled,
  'no-data-slot-restyle': noDataSlotRestyle,
};

/** React components built from @zukhruf/shadcn, shadcn/ui on Base UI. */
export const shadcn: Concept = {
  name: 'shadcn',
  rules,
  config: (plugins) => [
    // The setting has no `files`, so `zukhruf/require-shadcn-config` of `base`
    // finds it in every file the config covers, a `.ts` file too.
    { name: 'zukhruf/shadcn/plugins', plugins, settings: SHADCN_SETTINGS },
    {
      name: 'zukhruf/shadcn',
      files: JSX,
      rules: {
        ...enable(enabled),
        // Off until @zukhruf/shadcn has the variants and sizes that hosts
        // now get by restyling its parts (#5015, #5017).
        'zukhruf/no-data-slot-restyle': 'off',
      },
    },
  ],
};
