import * as jsonc from 'jsonc-eslint-parser';

import { type Concept, enable } from '../concept.ts';
import { PACKAGE_JSON, PROJECT_JSON } from '../files.ts';
import noDependsOnProject from './no-depends-on-project.ts';
import noDuplicateNxKey from './no-duplicate-nx-key.ts';
import noGeneratePackageJson from './no-generate-package-json.ts';
import noMissingAssetInput from './no-missing-asset-input.ts';
import noMissingCommandExecutor from './no-missing-command-executor.ts';
import noMissingDependencyBuild from './no-missing-dependency-build.ts';
import noMissingTestTimeout from './no-missing-test-timeout.ts';

/** Rules of a target, wherever Nx reads it: project.json or the `nx` key of package.json. */
const targetRules = {
  'no-missing-command-executor': noMissingCommandExecutor,
  'no-depends-on-project': noDependsOnProject,
  'no-generate-package-json': noGeneratePackageJson,
  'no-missing-test-timeout': noMissingTestTimeout,
};

const rules = {
  'no-missing-asset-input': noMissingAssetInput,
  'no-missing-dependency-build': noMissingDependencyBuild,
  'no-duplicate-nx-key': noDuplicateNxKey,
  ...targetRules,
};

/**
 * Nx project configuration, in project.json and in the `nx` key of
 * package.json: target options that Nx reads without complaint when they are
 * wrong.
 */
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
    {
      name: 'zukhruf/nx-project-json/package-json',
      files: PACKAGE_JSON,
      languageOptions: { parser: jsonc },
      rules: enable(targetRules),
    },
  ],
};
