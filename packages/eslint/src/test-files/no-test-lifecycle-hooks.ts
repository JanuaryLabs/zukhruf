import { selectorRule } from '../authoring/selector-rule.ts';

export default selectorRule({
  description:
    'Disallow test lifecycle hooks; each test arranges and tears down its own state',
  selectors: [
    'CallExpression[callee.name=/^(before|after|beforeEach|afterEach|beforeAll|afterAll)$/]',
  ],
  message:
    'No test lifecycle hooks. Write self-contained AAA tests: inline arrange in each test and run teardown (cleanup, mock restore, resource stop) in a per-test try/finally.',
});
