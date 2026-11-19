import { importBanRule } from '../authoring/import-ban.ts';

export default importBanRule({
  description: 'Disallow nock; msw is the one HTTP stub tool',
  packages: ['nock'],
  message:
    'Stub HTTP with msw; in a test, with `new Msw().intercept(...handlers)` from @zukhruf/testing/msw. A second stub tool escapes the lint checks on msw stubs.',
});
