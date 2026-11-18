import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const config = fixtureConfig(`{
  plugins: { zukhruf },
  extends: ['zukhruf/github-actions'],
}`);

const RULE = 'zukhruf/no-manual-workspace-install';

test('a job that sets up Node with actions/setup-node and runs npm ci is reported', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'eslint.config.mjs': config,
    '.github/workflows/ci.yml': `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: lts/*
          cache: npm
      - run: npm ci
      - run: npx nx affected -t test
`,
  });

  // Act
  const findings = lint(workspace.root, ['.']);

  // Assert
  assert.deepEqual(
    findings.map(({ file, ruleId }) => ({ file, ruleId })),
    [{ file: workspace.path('.github/workflows/ci.yml'), ruleId: RULE }],
  );
  assert.match(findings[0]?.message ?? '', /setup-workspace/);
});

test('a composite action whose block script runs npm ci after actions/setup-node is reported', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'eslint.config.mjs': config,
    '.github/actions/gate/action.yaml': `name: Gate
runs:
  using: composite
  steps:
    - name: Set up Node.js
      uses: actions/setup-node@v6
      with:
        node-version: lts/*
    - name: Install dependencies
      shell: bash
      run: |
        echo installing
        npm ci --no-audit --no-fund
`,
  });

  // Act
  const findings = lint(workspace.root, ['.']);

  // Assert
  assert.deepEqual(
    findings.map(({ file, ruleId }) => ({ file, ruleId })),
    [
      {
        file: workspace.path('.github/actions/gate/action.yaml'),
        ruleId: RULE,
      },
    ],
  );
});

test('a job that installs the workspace with the setup-workspace action passes', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'eslint.config.mjs': config,
    '.github/workflows/ci.yml': `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: JanuaryLabs/zukhruf/.github/actions/setup-workspace@main
      - run: npx nx affected -t test
`,
  });

  // Act
  const findings = lint(workspace.root, ['.']);

  // Assert
  assert.deepEqual(findings, []);
});

test('actions/setup-node in a job that does not run npm ci passes, though another job of the workflow runs npm ci', async () => {
  // Arrange: a job that only needs Node, such as one that installs a CLI.
  await using workspace = await fixtureWorkspace({
    'eslint.config.mjs': config,
    '.github/workflows/deploy.yml': `on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v7
        with:
          node-version: lts/*
      - run: npm install --global vercel@latest
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: JanuaryLabs/zukhruf/.github/actions/setup-workspace@main
      - run: npm ci --prefix tools/probe
`,
  });

  // Act
  const findings = lint(workspace.root, ['.']);

  // Assert
  assert.deepEqual(findings, []);
});
