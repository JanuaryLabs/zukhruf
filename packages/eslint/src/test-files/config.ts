import { type Concept, enable } from '../concept.ts';
import { TESTS } from '../files.ts';
import noTestLifecycleHooks from './no-test-lifecycle-hooks.ts';
import requireMswErrorOnUnhandledRequest from './require-msw-error-on-unhandled-request.ts';

const rules = {
  'no-test-lifecycle-hooks': noTestLifecycleHooks,
  'require-msw-error-on-unhandled-request': requireMswErrorOnUnhandledRequest,
};

export const tests: Concept = {
  name: 'tests',
  rules,
  config: (plugins) => [
    { name: 'zukhruf/tests', files: TESTS, plugins, rules: enable(rules) },
  ],
};
