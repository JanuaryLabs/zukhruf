import { type Concept, enable } from '../concept.ts';
import { CONFIG_FILES, GLOBAL_SETUP, TESTS, TEST_SUPPORT } from '../files.ts';
import noAssertInRetryUntilReady from './no-assert-in-retry-until-ready.ts';
import noCatchAllMswHandler from './no-catch-all-msw-handler.ts';
import noDirectMswServer from './no-direct-msw-server.ts';
import noGlobalTestMock from './no-global-test-mock.ts';
import noOwnModuleMock from './no-own-module-mock.ts';
import noOwnWaitLimit from './no-own-wait-limit.ts';
import noProcessEnvWrite from './no-process-env-write.ts';
import noShortTestTimeout from './no-short-test-timeout.ts';
import noSleepPollLoop from './no-sleep-poll-loop.ts';
import noTabularTest from './no-tabular-test.ts';
import noTestLifecycleHooks from './no-test-lifecycle-hooks.ts';
import noTimerRace from './no-timer-race.ts';
import noVitestGlobals from './no-vitest-globals.ts';
import noWallClockBound from './no-wall-clock-bound.ts';
import oneTestRunner from './one-test-runner.ts';
import preferEach from './prefer-each.ts';

const testFileRules = {
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
  'no-own-module-mock': noOwnModuleMock,
  'one-test-runner': oneTestRunner,
  'prefer-each': preferEach,
  'no-tabular-test': noTabularTest,
};

const rules = {
  ...testFileRules,
  'no-vitest-globals': noVitestGlobals,
};

export const tests: Concept = {
  name: 'tests',
  rules,
  config: (plugins) => [
    { name: 'zukhruf/tests/plugins', plugins },
    {
      name: 'zukhruf/tests',
      files: [...TESTS, ...TEST_SUPPORT],
      // no-tabular-test warns: repositories hold case tables looped inside one
      // test that move to test.each one by one (#5729).
      rules: { ...enable(testFileRules), 'zukhruf/no-tabular-test': 'warn' },
    },
    {
      // A global setup runs before any test process, and process.env is its only channel to them.
      name: 'zukhruf/tests/global-setup',
      files: GLOBAL_SETUP,
      rules: { 'zukhruf/no-process-env-write': 'off' },
    },
    {
      // Vitest reads its test options from a Vite or Vitest config.
      name: 'zukhruf/tests/vitest-config',
      files: CONFIG_FILES,
      rules: { 'zukhruf/no-vitest-globals': 'error' },
    },
  ],
};
