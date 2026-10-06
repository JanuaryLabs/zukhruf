import { type Concept, enable } from '../concept.ts';
import { SOURCE } from '../files.ts';
import noArbitraryZIndex from './no-arbitrary-z-index.ts';
import noHScreen from './no-h-screen.ts';
import noWillChange from './no-will-change.ts';

const rules = {
  'no-h-screen': noHScreen,
  'no-arbitrary-z-index': noArbitraryZIndex,
  'no-will-change': noWillChange,
};

export const tailwind: Concept = {
  name: 'tailwind',
  rules,
  config: (plugins) => [
    { name: 'zukhruf/tailwind', files: SOURCE, plugins, rules: enable(rules) },
  ],
};
