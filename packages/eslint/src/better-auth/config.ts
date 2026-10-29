import { type Concept, enable } from '../concept.ts';
import { TESTS, TEST_SUPPORT, TYPESCRIPT } from '../files.ts';
import noApiErrorInstanceof from './no-api-error-instanceof.ts';
import noOnApiErrorThrow from './no-on-api-error-throw.ts';

const rules = {
  'no-api-error-instanceof': noApiErrorInstanceof,
  'no-on-api-error-throw': noOnApiErrorThrow,
};

export const betterAuth: Concept = {
  name: 'better-auth',
  rules,
  config: (plugins) => [
    { name: 'zukhruf/better-auth/plugins', plugins },
    {
      name: 'zukhruf/better-auth',
      files: TYPESCRIPT,
      ignores: [...TESTS, ...TEST_SUPPORT],
      rules: enable(rules),
    },
  ],
};
