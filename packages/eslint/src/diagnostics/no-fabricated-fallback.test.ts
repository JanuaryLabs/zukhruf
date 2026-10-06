import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-fabricated-fallback.ts';

test('no-fabricated-fallback', () => {
  using workspace = fixtureWorkspace({ 'nx.json': '{}' });
  const backendOnly = [{ roots: ['apps/backend/src'] }];

  typescriptRuleTester().run('no-fabricated-fallback', rule, {
    valid: [
      {
        // A fallback to another real value invents nothing.
        code: 'const detail = event.detail ?? event.reason;',
        filename: workspace.path('packages/logging/src/diagnostics.ts'),
      },
      {
        // Single-token values are usually a genuine configuration choice, and
        // the rule deliberately leaves them to review rather than crying wolf.
        code: "const mode = config.mode ?? 'production';",
        filename: workspace.path('apps/backend/src/env.ts'),
      },
      {
        // Non-string fallbacks are outside this rule's subject entirely.
        code: 'const retries = options.retries ?? 0;',
        filename: workspace.path('apps/backend/src/client.ts'),
      },
      {
        code: "function decode(encoding = 'utf8') { return encoding; }",
        filename: workspace.path('packages/adapters/src/lib/base.adapter.ts'),
      },
      {
        // Tests stand up placeholder text on purpose.
        code: "const detail = raw ?? 'No diagnostic detail was available.';",
        filename: workspace.path('packages/logging/src/diagnostics.test.ts'),
      },
      {
        // An explicitly allowed string is a reviewed decision, not a reflex.
        code: "const label = name ?? 'not applicable';",
        filename: workspace.path('apps/backend/src/report.ts'),
        options: [{ allow: ['not applicable'] }],
      },
      {
        // The empty string is the identity for a string operation, not an
        // invented answer; flagging it catches boundary coercions, not
        // fabrication.
        code: 'const query = (message.text || "").trim();',
        filename: workspace.path(
          'apps/backend/src/core/integrations/handler.ts',
        ),
      },
      {
        // An interpolated template whose literal parts carry no whitespace is
        // an identifier being derived, not prose being invented.
        code: 'const sessionId = context.session.id ?? `session:${context.subject.id}`;',
        filename: workspace.path('apps/backend/src/core/session-context.ts'),
      },
      {
        // Outside the configured roots the rule does not run.
        code: "const detail = raw ?? 'No diagnostic detail was available.';",
        filename: workspace.path('packages/logging/src/diagnostics.ts'),
        options: backendOnly,
      },
      {
        // Inside the roots, a test file is still skipped.
        code: "const detail = raw ?? 'No diagnostic detail was available.';",
        filename: workspace.path('apps/backend/src/report.test.ts'),
        options: backendOnly,
      },
    ],
    invalid: [
      {
        // A placeholder sentence standing in for a missing log field.
        code: "const detail = raw ?? 'No diagnostic detail was available.';",
        filename: workspace.path('packages/logging/src/diagnostics.ts'),
        errors: [{ messageId: 'fabricatedFallback' }],
      },
      {
        // A `fallback = 'Unknown error'` parameter.
        code: "function errorDetail(error, fallback = 'Unknown error') { return fallback; }",
        filename: workspace.path('packages/stdlib/src/error-detail.ts'),
        errors: [{ messageId: 'fabricatedFallback' }],
      },
      {
        // Written without ever checking whether `message` can be empty.
        code: 'const text = error.message || `Request failed ${error.statusCode}`;',
        filename: workspace.path('apps/auth/src/app.ts'),
        errors: [{ messageId: 'fabricatedFallback' }],
      },
      {
        // Destructuring defaults are the same substitution in another shape.
        code: "const { summary = 'no summary provided' } = payload;",
        filename: workspace.path('apps/backend/src/report.ts'),
        errors: [{ messageId: 'fabricatedFallback' }],
      },
      {
        // A no-substitution template is a string literal wearing backticks.
        code: 'const detail = raw ?? `unavailable at this time`;',
        filename: workspace.path('packages/logging/src/diagnostics.ts'),
        errors: [{ messageId: 'fabricatedFallback' }],
      },
      {
        // Inside the configured roots the rule runs.
        code: "const detail = raw ?? 'No diagnostic detail was available.';",
        filename: workspace.path('apps/backend/src/report.ts'),
        options: backendOnly,
        errors: [{ messageId: 'fabricatedFallback' }],
      },
    ],
  });
});
