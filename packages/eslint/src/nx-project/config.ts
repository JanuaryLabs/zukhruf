import * as jsonc from 'jsonc-eslint-parser';

import { type Concept, enable } from '../concept.ts';
import { PROJECT_JSON } from '../files.ts';
import noMissingAssetInput from './no-missing-asset-input.ts';

const rules = { 'no-missing-asset-input': noMissingAssetInput };

/** Nx project.json files: target options that Nx reads without complaint when they are wrong. */
export const nxProjectJson: Concept = {
  name: 'nx-project-json',
  rules,
  config: (plugins) => [
    {
      name: 'zukhruf/nx-project-json',
      files: PROJECT_JSON,
      languageOptions: { parser: jsonc },
      plugins,
      rules: enable(rules),
    },
  ],
};
