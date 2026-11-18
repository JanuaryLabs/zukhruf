import { test } from 'node:test';

import { jsonRuleTester } from '../testing/rule-tester.ts';
import rule from './no-globstar-workspace.ts';

const ruleTester = jsonRuleTester();

test('each workspaces glob with a ** segment is reported', () => {
  // Arrange
  const code = JSON.stringify({
    name: '@acme/source',
    workspaces: ['apps/*', 'packages/**', '**/package.json', 'libs/**/src'],
  });

  // Act + Assert
  ruleTester.run('no-globstar-workspace', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: 'package.json',
        errors: [
          { messageId: 'globstar', data: { glob: 'packages/**' } },
          { messageId: 'globstar', data: { glob: '**/package.json' } },
          { messageId: 'globstar', data: { glob: 'libs/**/src' } },
        ],
      },
    ],
  });
});

test('single-* globs, explicit dot folders, negated globs and a manifest with no workspaces pass', () => {
  // Arrange
  const singleStar = JSON.stringify({
    workspaces: [
      'apps/*',
      'packages/*',
      'packages/sqlite/*',
      '.github/actions/*',
      'tools/**-cli',
    ],
  });
  const negated = JSON.stringify({
    workspaces: ['packages/*', '!packages/**/dist'],
  });
  const noWorkspaces = JSON.stringify({ name: '@acme/lib', files: ['**'] });

  // Act + Assert
  ruleTester.run('no-globstar-workspace', rule, {
    valid: [
      { code: singleStar, filename: 'package.json' },
      { code: negated, filename: 'package.json' },
      { code: noWorkspaces, filename: 'packages/lib/package.json' },
    ],
    invalid: [],
  });
});
