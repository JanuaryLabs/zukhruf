import * as jsonc from 'jsonc-eslint-parser';

import { type Concept, enable } from '../concept.ts';
import { PROJECT_JSON } from '../files.ts';
import noMissingAssetInput from './no-missing-asset-input.ts';
import noMissingDependencyBuild from './no-missing-dependency-build.ts';

const rules = {
  'no-missing-asset-input': noMissingAssetInput,
  'no-missing-dependency-build': noMissingDependencyBuild,
};

/** Nx project.json files: target options that Nx reads without complaint when they are wrong. */
export const nxProjectJson: Concept = {
  name: 'nx-project-json',
  rules,
  config: (plugins) => [
    { name: 'zukhruf/nx-project-json/plugins', plugins },
    {
      name: 'zukhruf/nx-project-json',
      files: PROJECT_JSON,
      languageOptions: { parser: jsonc },
      rules: enable(rules),
    },
  ],
};
