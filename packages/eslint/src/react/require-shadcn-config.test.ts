import assert from 'node:assert/strict';
import { once } from 'node:events';
import { relative } from 'node:path';
import { test } from 'node:test';

import zukhruf from '../plugin.ts';
import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

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
  include: ['**/*.ts', '**/*.tsx'],
});

const dialog = [
  `import { DialogTrigger } from '@zukhruf/shadcn';`,
  `export const Open = () => <DialogTrigger asChild><a href="/" /></DialogTrigger>;`,
  ``,
].join('\n');

const kitFindings = (root: string, findings: ReturnType<typeof lint>) =>
  findings
    .filter(({ ruleId }) =>
      ['zukhruf/require-shadcn-config', 'zukhruf/no-as-child'].includes(
        ruleId ?? '',
      ),
    )
    .map(({ file, ruleId }) => `${relative(root, file)}: ${ruleId}`);

test('a file that imports @zukhruf/shadcn under a config with the React community preset and base only is reported', async () => {
  // Arrange: the community preset, then base, as Meddit's web app had it.
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': [
      `import react from ${JSON.stringify(import.meta.resolve('@zukhruf/eslint/react'))};`,
      fixtureConfig(
        `...react, { plugins: { zukhruf }, extends: ['zukhruf/base'] }`,
      ),
    ].join('\n'),
    'src/open.tsx': dialog,
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.deepEqual(kitFindings(workspace.root, findings), [
    'src/open.tsx: zukhruf/require-shadcn-config',
  ]);
  assert.match(
    findings.find(({ ruleId }) => ruleId === 'zukhruf/require-shadcn-config')
      ?.message ?? '',
    /extends: \['zukhruf\/shadcn'\]/,
  );
});

test('the shadcn config, by extends and by spread, runs the kit rules and satisfies the guard', async () => {
  for (const shadcn of [
    `{ plugins: { zukhruf }, extends: ['zukhruf/base', 'zukhruf/shadcn'] }`,
    `...zukhruf.configs['base'], ...zukhruf.configs['shadcn']`,
  ]) {
    // Arrange
    await using workspace = await fixtureWorkspace({
      'nx.json': '{}',
      'tsconfig.json': tsconfig,
      'eslint.config.mjs': fixtureConfig(shadcn),
      'src/open.tsx': dialog,
      'src/kit.ts': `export { cn } from '@zukhruf/shadcn';\nimport type { ButtonProps } from '@zukhruf/shadcn';\nexport type Props = ButtonProps;\n`,
    });

    // Act
    const findings = lint(workspace.root, ['src']);

    // Assert
    assert.deepEqual(
      kitFindings(workspace.root, findings),
      ['src/open.tsx: zukhruf/no-as-child'],
      shadcn,
    );
  }
});

test('the deprecated react name, by extends and by spread, still runs the kit rules and satisfies the guard', async () => {
  for (const react of [
    `{ plugins: { zukhruf }, extends: ['zukhruf/base', 'zukhruf/react'] }`,
    `...zukhruf.configs['base'], ...zukhruf.configs['react']`,
  ]) {
    // Arrange
    await using workspace = await fixtureWorkspace({
      'nx.json': '{}',
      'tsconfig.json': tsconfig,
      'eslint.config.mjs': fixtureConfig(react),
      'src/open.tsx': dialog,
    });

    // Act
    const findings = lint(workspace.root, ['src']);

    // Assert
    assert.deepEqual(
      kitFindings(workspace.root, findings),
      ['src/open.tsx: zukhruf/no-as-child'],
      react,
    );
  }
});

test('reading the react config warns that it is deprecated and names shadcn', async () => {
  // Arrange
  const warned = once(process, 'warning');

  // Act
  const react = zukhruf.configs['react'];

  // Assert
  const [warning] = await warned;
  assert.equal(react, zukhruf.configs['shadcn']);
  assert.ok(Error.isError(warning));
  assert.equal(warning.name, 'DeprecationWarning');
  assert.match(warning.message, /zukhruf\/shadcn/);
  assert.deepEqual(
    Object.keys(zukhruf.configs).filter((name) => name === 'react'),
    [],
  );
});

test('the shadcn config scoped to some folders leaves a kit import outside them reported', async () => {
  // Arrange: the shape of zukhruf's own root config, `extends` under `files`.
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(`
      { plugins: { zukhruf }, extends: ['zukhruf/base'] },
      { files: ['packages/ui/**'], plugins: { zukhruf }, extends: ['zukhruf/shadcn'] },
    `),
    'packages/ui/src/open.tsx': dialog,
    'apps/web/src/open.tsx': dialog,
  });

  // Act
  const findings = lint(workspace.root, ['packages', 'apps']);

  // Assert
  assert.deepEqual(kitFindings(workspace.root, findings).sort(), [
    'apps/web/src/open.tsx: zukhruf/require-shadcn-config',
    'packages/ui/src/open.tsx: zukhruf/no-as-child',
  ]);
});
