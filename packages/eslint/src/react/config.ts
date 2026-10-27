import { type Concept, enable } from '../concept.ts';
import { JSX } from '../files.ts';
import noAsChild from './no-as-child.ts';

const rules = { 'no-as-child': noAsChild };

/** React components built from shadcn/ui and Base UI primitives. */
export const react: Concept = {
  name: 'react',
  rules,
  config: (plugins) => [
    { name: 'zukhruf/react/plugins', plugins },
    { name: 'zukhruf/react', files: JSX, rules: enable(rules) },
  ],
};
