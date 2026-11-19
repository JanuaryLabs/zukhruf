import * as jsonc from 'jsonc-eslint-parser';

import { type Concept, enable } from '../concept.ts';
import { TSCONFIG } from '../files.ts';
import noCrossProjectPaths from './no-cross-project-paths.ts';
import noVitestGlobalsTypes from './no-vitest-globals-types.ts';

const rules = {
  'no-cross-project-paths': noCrossProjectPaths,
  'no-vitest-globals-types': noVitestGlobalsTypes,
};

/** tsconfig files: compiler options that cross a project boundary or declare globals. */
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
