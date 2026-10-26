import { type Concept, enable } from '../concept.ts';
import { TESTS, TEST_SUPPORT } from '../files.ts';
import noCatchAllMswHandler from './no-catch-all-msw-handler.ts';
import noDirectMswServer from './no-direct-msw-server.ts';
import noProcessEnvWrite from './no-process-env-write.ts';
import noTestLifecycleHooks from './no-test-lifecycle-hooks.ts';
import noTimerRace from './no-timer-race.ts';

const rules = {
  'no-test-lifecycle-hooks': noTestLifecycleHooks,
  'no-process-env-write': noProcessEnvWrite,
  'no-direct-msw-server': noDirectMswServer,
  'no-catch-all-msw-handler': noCatchAllMswHandler,
  'no-timer-race': noTimerRace,
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
