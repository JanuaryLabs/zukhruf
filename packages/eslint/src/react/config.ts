import { type Concept, enable } from '../concept.ts';
import { JSX } from '../files.ts';
import noAsChild from './no-as-child.ts';
import requireComboboxPopoverModal from './require-combobox-popover-modal.ts';

const rules = {
  'no-as-child': noAsChild,
  'require-combobox-popover-modal': requireComboboxPopoverModal,
};

/** React components built from shadcn/ui and Base UI primitives. */
export const react: Concept = {
  name: 'react',
  rules,
  config: (plugins) => [
    { name: 'zukhruf/react', files: JSX, plugins, rules: enable(rules) },
  ],
};
