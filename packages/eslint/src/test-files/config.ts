import { type Concept, enable } from '../concept.ts';
import { TESTS, TEST_SUPPORT } from '../files.ts';
import noAssertInRetryUntilReady from './no-assert-in-retry-until-ready.ts';
import noCatchAllMswHandler from './no-catch-all-msw-handler.ts';
import noDirectMswServer from './no-direct-msw-server.ts';
import noGlobalTestMock from './no-global-test-mock.ts';
import noOwnWaitLimit from './no-own-wait-limit.ts';
import noProcessEnvWrite from './no-process-env-write.ts';
import noShortTestTimeout from './no-short-test-timeout.ts';
import noSleepPollLoop from './no-sleep-poll-loop.ts';
import noTestLifecycleHooks from './no-test-lifecycle-hooks.ts';
import noTimerRace from './no-timer-race.ts';
import noWallClockBound from './no-wall-clock-bound.ts';

const rules = {
  'no-test-lifecycle-hooks': noTestLifecycleHooks,
  'no-process-env-write': noProcessEnvWrite,
  'no-direct-msw-server': noDirectMswServer,
  'no-catch-all-msw-handler': noCatchAllMswHandler,
  'no-timer-race': noTimerRace,
  'no-sleep-poll-loop': noSleepPollLoop,
  'no-wall-clock-bound': noWallClockBound,
  'no-short-test-timeout': noShortTestTimeout,
  'no-own-wait-limit': noOwnWaitLimit,
  'no-global-test-mock': noGlobalTestMock,
  'no-assert-in-retry-until-ready': noAssertInRetryUntilReady,
};

export const tests: Concept = {
  name: 'tests',
  rules,
  config: (plugins) => [
    { name: 'zukhruf/tests/plugins', plugins },
    {
      name: 'zukhruf/tests',
      files: [...TESTS, ...TEST_SUPPORT],
      rules: enable(rules),
    },
  ],
};
