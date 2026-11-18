import * as yaml from 'yaml-eslint-parser';

import { type Concept, enable } from '../concept.ts';
import { GITHUB_ACTIONS } from '../files.ts';
import noManualWorkspaceInstall from './no-manual-workspace-install.ts';

const rules = { 'no-manual-workspace-install': noManualWorkspaceInstall };

/** GitHub Actions workflows and actions: how a job sets up the workspace. */
export const githubActions: Concept = {
  name: 'github-actions',
  rules,
  config: (plugins) => [
    { name: 'zukhruf/github-actions/plugins', plugins },
    {
      name: 'zukhruf/github-actions',
      files: GITHUB_ACTIONS,
      languageOptions: { parser: yaml },
      rules: enable(rules),
    },
  ],
};
