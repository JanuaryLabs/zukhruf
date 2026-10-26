import { type Concept, enable } from '../concept.ts';
import { TESTS, TEST_SUPPORT } from '../files.ts';
import noProcessEnvWrite from './no-process-env-write.ts';
import noTestLifecycleHooks from './no-test-lifecycle-hooks.ts';
import requireMswErrorOnUnhandledRequest from './require-msw-error-on-unhandled-request.ts';

const rules = {
  'no-test-lifecycle-hooks': noTestLifecycleHooks,
  'no-process-env-write': noProcessEnvWrite,
  'require-msw-error-on-unhandled-request': requireMswErrorOnUnhandledRequest,
};

export const tests: Concept = {
  name: 'tests',
  rules,
  config: (plugins) => [
    {
      name: 'zukhruf/tests',
      files: [...TESTS, ...TEST_SUPPORT],
      plugins,
      rules: enable(rules),
    },
  ],
};
