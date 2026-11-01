import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from './testing/fixture-workspace.ts';
import { fixtureConfig, lint } from './testing/run-eslint.ts';

// `types: []` keeps the fixture from loading @types the temporary folder does
// not have.
const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: 'esnext',
    jsx: 'preserve',
    types: [],
  },
  include: ['**/*.tsx'],
});

// A React project config: the preset first, then the root config.
const reactProjectConfig = [
  `import react from ${JSON.stringify(import.meta.resolve('@zukhruf/eslint/react'))};`,
  fixtureConfig(
    `...react, { plugins: { zukhruf }, extends: ['zukhruf/base'] }`,
  ),
].join('\n');

test('./react lints a .tsx file on ESLint 10 with type information and reports a number that renders as text', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': reactProjectConfig,
    'src/count.tsx': [
      `export const Count = ({ count }: { count: number }) => (`,
      `  <div>{count && <span>{count}</span>}</div>`,
      `);`,
      ``,
    ].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.ok(
    findings.some(
      ({ ruleId }) =>
        ruleId === '@eslint-react/no-leaked-conditional-rendering',
    ),
    JSON.stringify(findings),
  );
});

test('./react reports a list item that has no key', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': reactProjectConfig,
    'src/list.tsx': [
      `export const List = ({ items }: { items: string[] }) => (`,
      `  <ul>{items.map((item) => <li>{item}</li>)}</ul>`,
      `);`,
      ``,
    ].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.ok(
    findings.some(({ ruleId }) => ruleId === '@eslint-react/no-missing-key'),
    JSON.stringify(findings),
  );
});

test('./react reports a hook called in a condition one time, from @eslint-react', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': reactProjectConfig,
    'src/toggle.tsx': [
      `import { useState } from 'react';`,
      `export function Toggle({ on }: { on: boolean }) {`,
      `  if (on) {`,
      `    useState(0);`,
      `  }`,
      `  return <div />;`,
      `}`,
      ``,
    ].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  const hookRules = findings
    .map(({ ruleId }) => ruleId)
    .filter((ruleId) => ruleId?.endsWith('rules-of-hooks'));
  assert.deepEqual(hookRules, ['@eslint-react/rules-of-hooks']);
});

test('./react reports a React Compiler finding from eslint-plugin-react-hooks', async () => {
  // Arrange: react-hook-form's watch() is on the compiler's list of
  // incompatible library APIs.
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': reactProjectConfig,
    'src/form.tsx': [
      `import { useForm } from 'react-hook-form';`,
      `export function Form() {`,
      `  const { watch } = useForm();`,
      `  return <p>{watch('name')}</p>;`,
      `}`,
      ``,
    ].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.ok(
    findings.some(
      ({ ruleId }) => ruleId === 'react-hooks/incompatible-library',
    ),
    JSON.stringify(findings),
  );
});

test('./react reports an image that has no alt text', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': reactProjectConfig,
    'src/logo.tsx': 'export const Logo = () => <img src="logo.png" />;\n',
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.ok(
    findings.some(({ ruleId }) => ruleId === 'jsx-a11y-x/alt-text'),
    JSON.stringify(findings),
  );
});
