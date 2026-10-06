import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { jsonRuleTester } from '../testing/rule-tester.ts';
import rule from './no-missing-asset-input.ts';

const ruleTester = jsonRuleTester();

function projectJson(assets: string): string {
  return `{"targets":{"build":{"options":{"assets":${assets}}}}}`;
}

test('no-missing-asset-input', () => {
  using workspace = fixtureWorkspace({
    'nx.json': '{}',
    'openapi.json': '{}',
    'packages/assets/skills/.keep': '',
  });
  const filename = workspace.path('apps/backend/project.json');

  ruleTester.run('no-missing-asset-input', rule, {
    valid: [
      // An object entry whose input directory exists.
      {
        code: projectJson(
          '[{"input":"packages/assets/skills","glob":"**","output":"./assets/skills"}]',
        ),
        filename,
      },
      // Nx's Vite copy plugin receives object inputs relative to the project root.
      {
        code: projectJson(
          '[{"input":"../../packages/assets/skills","glob":"**","output":"./assets/skills"}]',
        ),
        filename: workspace.path('apps/frontend/project.json'),
      },
      // A string entry can resolve from the workspace root.
      {
        code: projectJson('["./openapi.json"]'),
        filename,
      },
      // A glob string only needs its magic-free base directory to exist.
      {
        code: projectJson('["packages/assets/**/*.md"]'),
        filename,
      },
      // An `assets` array outside `targets` is not an executor asset list.
      {
        code: '{"metadata":{"assets":["./does-not-exist.json"]}}',
        filename,
      },
      // Outside any workspace the rule stays silent.
      {
        code: projectJson('["./does-not-exist.json"]'),
        filename: join(tmpdir(), 'not-a-workspace', 'project.json'),
      },
    ],
    invalid: [
      // A dead input directory copies nothing while the build stays green.
      {
        code: projectJson(
          '[{"input":"apps/backend/src/assets/skills","glob":"**","output":"./assets/skills"}]',
        ),
        filename,
        errors: [{ messageId: 'missingInput' }],
      },
      // An input pointing at a file can never glob — it must be a directory.
      {
        code: projectJson(
          '[{"input":"openapi.json","glob":"**","output":"./x"}]',
        ),
        filename,
        errors: [{ messageId: 'missingInput' }],
      },
      // A dead string entry.
      {
        code: projectJson('["./does-not-exist.json"]'),
        filename,
        errors: [{ messageId: 'missingPattern' }],
      },
      // A glob whose static base directory is gone.
      {
        code: projectJson('["apps/gone/**"]'),
        filename,
        errors: [{ messageId: 'missingPattern' }],
      },
      // Configuration-level assets are validated too, not just options.
      {
        code: '{"targets":{"build":{"configurations":{"production":{"assets":["apps/gone/**"]}}}}}',
        filename,
        errors: [{ messageId: 'missingPattern' }],
      },
    ],
  });
});

test('no-missing-asset-input: root-ignored assets', () => {
  using workspace = fixtureWorkspace({
    'nx.json': '{}',
    '.gitignore': 'apps/v2/backend/openapi.json\ndist\n*.tsbuildinfo\n',
    '.nxignore': 'vendor/**\n',
    'apps/v2/backend/dist/.keep': '',
    'apps/v2/backend/openapi.json': '{}',
    'apps/v3/backend/.gitignore': 'openapi.json\n',
    'vendor/schema.json': '{}',
  });
  const filename = workspace.path('apps/v2/backend/project.json');

  ruleTester.run('no-missing-asset-input', rule, {
    valid: [
      // Nx reads only the root ignore files, so a project-level .gitignore
      // keeps a generated asset out of git without dropping it from dist.
      {
        code: projectJson(
          '[{"input":"apps/v3/backend","glob":"openapi.json","output":"."}]',
        ),
        filename: workspace.path('apps/v3/backend/project.json'),
      },
      // A project-root-relative input that reaches a workspace-root file
      // resolves inside the workspace, never above it.
      {
        code: projectJson(
          '[{"input":"../..","glob":"openapi.json","output":"server"}]',
        ),
        filename: workspace.path('apps/docs/project.json'),
      },
      // Ignored files inside a copied directory are dropped on purpose; only
      // an ignored base directory means the glob can copy nothing.
      {
        code: projectJson(
          '[{"input":"apps/v2/backend","glob":"**","output":"."}]',
        ),
        filename,
      },
    ],
    invalid: [
      // A generated file ignored from the root .gitignore builds green while
      // Nx's asset copy drops it from dist.
      {
        code: projectJson(
          '[{"input":"apps/v2/backend","glob":"openapi.json","output":"."}]',
        ),
        filename,
        errors: [{ messageId: 'ignoredAsset' }],
      },
      // The same file written as a string entry.
      {
        code: projectJson('["apps/v2/backend/openapi.json"]'),
        filename,
        errors: [{ messageId: 'ignoredAsset' }],
      },
      // A glob whose base directory is ignored can only match dropped files.
      {
        code: projectJson('["apps/v2/backend/dist/**"]'),
        filename,
        errors: [{ messageId: 'ignoredAsset' }],
      },
      // Nx reads the root .nxignore alongside the root .gitignore.
      {
        code: projectJson('["vendor/schema.json"]'),
        filename,
        errors: [{ messageId: 'ignoredAsset' }],
      },
    ],
  });
});
