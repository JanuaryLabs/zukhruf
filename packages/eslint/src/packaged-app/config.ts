import { type Concept, enable } from '../concept.ts';
import { TESTS, TYPESCRIPT } from '../files.ts';
import noBareSpawn from './no-bare-spawn.ts';

const rules = { 'no-bare-spawn': noBareSpawn };

/** An app installed and launched outside a terminal, which gets the OS's minimal PATH. */
export const packagedApp: Concept = {
  name: 'packaged-app',
  rules,
  config: (plugins) => [
    {
      name: 'zukhruf/packaged-app',
      files: TYPESCRIPT,
      ignores: TESTS,
      plugins,
      rules: enable(rules),
    },
  ],
};
