import { type Concept, enable } from '../concept.ts';
import { JSX } from '../files.ts';
import requireComboboxPopoverModal from './require-combobox-popover-modal.ts';

const rules = { 'require-combobox-popover-modal': requireComboboxPopoverModal };

/** React components built from shadcn/ui and Radix primitives. */
export const react: Concept = {
  name: 'react',
  rules,
  config: (plugins) => [
    { name: 'zukhruf/react', files: JSX, plugins, rules: enable(rules) },
  ],
};
