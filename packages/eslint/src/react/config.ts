import { type Concept, enable } from '../concept.ts';
import { JSX } from '../files.ts';
import noAsChild from './no-as-child.ts';
import noNativeSelect from './no-native-select.ts';
import requireSelectGroup from './require-select-group.ts';

const rules = {
  'no-as-child': noAsChild,
  'no-native-select': noNativeSelect,
  'require-select-group': requireSelectGroup,
};

/** React components built from shadcn/ui and Base UI primitives. */
export const react: Concept = {
  name: 'react',
  rules,
  config: (plugins) => [
    { name: 'zukhruf/react/plugins', plugins },
    { name: 'zukhruf/react', files: JSX, rules: enable(rules) },
  ],
};
