import { importBanRule } from '../authoring/import-ban.ts';

export default importBanRule({
  description: 'Disallow the Playwright test runner; node:test is the runner',
  packages: ['@playwright/test'],
  message: 'Use node:test.',
});
