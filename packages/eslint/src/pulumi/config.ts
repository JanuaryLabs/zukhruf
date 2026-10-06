import { type Concept, enable } from '../concept.ts';
import { TYPESCRIPT } from '../files.ts';
import requireServerReplaceGuard from './require-server-replace-guard.ts';

const rules = { 'require-server-replace-guard': requireServerReplaceGuard };

export const pulumi: Concept = {
  name: 'pulumi',
  rules,
  config: (plugins) => [
    {
      name: 'zukhruf/pulumi',
      files: TYPESCRIPT,
      plugins,
      rules: enable(rules),
    },
  ],
};
