import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './consistent-event-name.ts';

test('consistent-event-name', () => {
  typescriptRuleTester().run('consistent-event-name', rule, {
    valid: [
      "logError({ event: 'dashboard.index.read.failed' }, error);",
      // Hyphens inside a segment: some domains are genuinely two words.
      "logError({ event: 'data-source.staged-file.cleanup.failed' }, error);",
      "logEvent('info', { event: 'auto-update.staged', version });",
      // Quoted key form.
      "logError({ 'event': 'chat.run.failed' }, error);",
      // Both ternary arms are canonical.
      "logError({ event: ok ? 'installed-app.module-verification.loaded' : 'installed-app.module-verification.failed' }, error);",
      // A non-literal value cannot be checked statically; not this rule's job.
      'logError({ event: computedName }, error);',
      // An `event` key that is not a log name (e.g. a DOM event object).
      'handler({ event: domEvent });',
    ],
    invalid: [
      {
        // snake_case: the competing convention.
        code: "logError({ event: 'dashboard_index_invalid' }, error);",
        errors: [{ messageId: 'badName' }],
      },
      {
        // Single segment: no hierarchy to filter on.
        code: "logError({ event: 'failed' }, error);",
        errors: [{ messageId: 'badName' }],
      },
      {
        code: "logError({ event: 'Dashboard.Index.Failed' }, error);",
        errors: [{ messageId: 'badName' }],
      },
      {
        // Only the snake_case arm of the ternary is reported.
        code: "logError({ event: ok ? 'a.b' : 'a_b' }, error);",
        errors: [{ messageId: 'badName' }],
      },
    ],
  });
});
