import * as jsonc from 'jsonc-eslint-parser';

import { type Concept, enable } from '../concept.ts';
import { TSCONFIG } from '../files.ts';
import noCrossProjectPaths from './no-cross-project-paths.ts';

const rules = { 'no-cross-project-paths': noCrossProjectPaths };

/** tsconfig files: compiler options that cross a project boundary. */
export const tsconfig: Concept = {
  name: 'tsconfig',
  rules,
  config: (plugins) => [
    { name: 'zukhruf/tsconfig/plugins', plugins },
    {
      name: 'zukhruf/tsconfig',
      files: TSCONFIG,
      languageOptions: { parser: jsonc },
      rules: enable(rules),
    },
  ],
};
