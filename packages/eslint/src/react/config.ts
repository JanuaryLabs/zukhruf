import { type Concept, enable } from '../concept.ts';
import { JSX } from '../files.ts';
import noAsChild from './no-as-child.ts';
import noDataSlotRestyle from './no-data-slot-restyle.ts';
import noNativeSelect from './no-native-select.ts';
import requireSelectGroup from './require-select-group.ts';

const enabled = {
  'no-as-child': noAsChild,
  'no-native-select': noNativeSelect,
  'require-select-group': requireSelectGroup,
};

const rules = {
  ...enabled,
  'no-data-slot-restyle': noDataSlotRestyle,
};

/** React components built from shadcn/ui and Base UI primitives. */
export const react: Concept = {
  name: 'react',
  rules,
  config: (plugins) => [
    { name: 'zukhruf/react/plugins', plugins },
    {
      name: 'zukhruf/react',
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
