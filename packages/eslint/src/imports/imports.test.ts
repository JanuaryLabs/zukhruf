import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import noOtherTestRunner from './no-other-test-runner.ts';
import noPlaywrightTest from './no-playwright-test.ts';
import noStateManagers from './no-state-managers.ts';
import noTestFileImport from './no-test-file-import.ts';

test('no-state-managers bans each package and its subpaths in every import form', () => {
  typescriptRuleTester().run('no-state-managers', noStateManagers, {
    valid: [
      { code: `import { useQuery } from '@tanstack/react-query';` },
      // A package whose name merely starts with a banned one.
      { code: `import x from 'zustand-adjacent';` },
    ],
    invalid: [
      { code: `import { create } from 'zustand';` },
      { code: `import { persist } from 'zustand/middleware';` },
      { code: `import type { Store } from 'redux';` },
      { code: `export { atom } from 'jotai';` },
      { code: `export * from 'mobx';` },
      { code: `const toolkit = await import('@reduxjs/toolkit');` },
    ].map((item) => ({ ...item, errors: [{ messageId: 'banned' }] })),
  });
});

test('no-playwright-test', () => {
  typescriptRuleTester().run('no-playwright-test', noPlaywrightTest, {
    valid: [
      { code: `import { test } from 'node:test';` },
      { code: `import { chromium } from 'playwright';` },
    ],
    invalid: [
      {
        code: `import { test } from '@playwright/test';`,
        errors: [{ messageId: 'banned' }],
      },
    ],
  });
});

test('no-other-test-runner bans each runner but node:test and Vitest', () => {
  typescriptRuleTester().run('no-other-test-runner', noOtherTestRunner, {
    valid: [
      { code: `import { test } from 'node:test';` },
      { code: `import { expect, test } from 'vitest';` },
      // The jest-dom matchers that a Vite app's Vitest setup registers.
      { code: `import '@testing-library/jest-dom/vitest';` },
    ],
    invalid: [
      { code: `import { expect, jest } from '@jest/globals';` },
      { code: `import { run } from 'jest';` },
      { code: `import type { Config } from 'jest/config';` },
      { code: `import { describe } from 'mocha';` },
      { code: `import 'jasmine';` },
      { code: `import test from 'ava';` },
      { code: `import t from 'tap';` },
      { code: `import test from 'tape';` },
      { code: `import { test } from 'uvu';` },
    ].map((item) => ({ ...item, errors: [{ messageId: 'banned' }] })),
  });
});

test('no-test-file-import reports every import form of a .test. or .spec. file', () => {
  typescriptRuleTester().run('no-test-file-import', noTestFileImport, {
    valid: [
      { code: `import { arrange } from './helpers.ts';` },
      { code: `import { test } from 'node:test';` },
      { code: `import { cases } from './testing/store-cases.ts';` },
      // A name that only contains the word.
      { code: `import { latest } from './latest.test-data.ts';` },
      { code: `import snapshot from './api.test.ts.snap';` },
      { code: `const key = './a.test.ts';` },
    ],
    invalid: [
      { code: `import { server } from './api.test.ts';` },
      { code: `import './setup.spec.js';` },
      { code: `import type { Case } from '../cases.test.mts';` },
      { code: `export { server } from './api.spec.tsx';` },
      { code: `export * from './api.test.cjs';` },
      { code: `const module = await import('./api.test.ts');` },
      { code: `const module = require('./api.test.cts');` },
    ].map((item) => ({ ...item, errors: [{ messageId: 'matched' }] })),
  });
});
