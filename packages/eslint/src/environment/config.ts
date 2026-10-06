import { type Concept, enable } from '../concept.ts';
import { TESTS, TYPESCRIPT } from '../files.ts';
import noDefaultForPathEnv from './no-default-for-path-env.ts';
import noSingleEnvReadWrapper from './no-single-env-read-wrapper.ts';
import noUndeclaredProcessEnv from './no-undeclared-process-env.ts';

const rules = {
  'no-undeclared-process-env': noUndeclaredProcessEnv,
  'no-single-env-read-wrapper': noSingleEnvReadWrapper,
  'no-default-for-path-env': noDefaultForPathEnv,
};

/**
 * A service that validates its environment once, in a startup zod schema
 * (`const env = z.object({...})`), and reads it only through declared keys.
 */
export const env: Concept = {
  name: 'env',
  rules,
  config: (plugins) => [
    {
      name: 'zukhruf/env',
      files: TYPESCRIPT,
      ignores: TESTS,
      plugins,
      rules: enable(rules),
    },
  ],
};
