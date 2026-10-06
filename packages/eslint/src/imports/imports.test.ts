import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import noDeepagentsAgent from './no-deepagents-agent.ts';
import noPlaywrightTest from './no-playwright-test.ts';
import noStateManagers from './no-state-managers.ts';

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

test('no-deepagents-agent', () => {
  typescriptRuleTester().run('no-deepagents-agent', noDeepagentsAgent, {
    valid: [{ code: `import { engine } from '@deepagents/context';` }],
    invalid: [
      {
        code: `import { agent } from '@deepagents/agent';`,
        errors: [{ messageId: 'banned' }],
      },
    ],
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
