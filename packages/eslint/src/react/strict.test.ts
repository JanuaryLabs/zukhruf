import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint, printConfig } from '../testing/run-eslint.ts';
import { isRecord } from '../unknown-values.ts';

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

const STRICT_RULES = [
  'zukhruf/no-data-slot-restyle',
  'shadcn/no-restyle',
  'shadcn/no-arbitrary-values',
  'shadcn/no-raw-colors',
  'shadcn/no-unknown-classes',
  'shadcn/no-inline-styles',
  'shadcn/require-static-classes',
];

// A div that restyles the kit's input through its data-slot and sets an
// inline style.
const box = [
  `export const Box = () => (`,
  `  <div style={{ display: 'grid' }} className="[&_[data-slot=input]]:h-12" />`,
  `);`,
  ``,
].join('\n');

const strictConfig = [
  `import shadcnStrict from ${JSON.stringify(import.meta.resolve('@zukhruf/eslint/shadcn-strict'))};`,
  fixtureConfig(
    `...zukhruf.configs['base'], ...zukhruf.configs['shadcn'], ...shadcnStrict`,
  ),
].join('\n');

function severities(config: unknown): Record<string, unknown> {
  const rules = isRecord(config) ? config['rules'] : undefined;
  return Object.fromEntries(
    STRICT_RULES.map((rule) => {
      const entry = isRecord(rules) ? rules[rule] : undefined;
      return [rule, Array.isArray(entry) ? entry[0] : entry];
    }),
  );
}

test('./shadcn-strict after the shadcn config turns on the six @shadcn/lint rules and no-data-slot-restyle at error', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': strictConfig,
    'src/box.tsx': box,
  });

  // Act
  const config = printConfig(workspace.root, 'src/box.tsx');

  // Assert
  assert.deepEqual(
    severities(config),
    Object.fromEntries(STRICT_RULES.map((rule) => [rule, 2])),
  );
});

test('./shadcn-strict reports a data-slot restyle of a kit part and an inline style', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': strictConfig,
    'src/box.tsx': box,
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  const ruleIds = findings.map(({ ruleId }) => ruleId);
  assert.ok(
    ruleIds.includes('zukhruf/no-data-slot-restyle'),
    JSON.stringify(findings),
  );
  assert.ok(
    ruleIds.includes('shadcn/no-inline-styles'),
    JSON.stringify(findings),
  );
});

test('the shadcn config without ./shadcn-strict turns on none of the strict rules, so a host that has not opted in gets no finding from them', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(
      `...zukhruf.configs['base'], ...zukhruf.configs['shadcn']`,
    ),
    'src/box.tsx': box,
  });

  // Act
  const config = printConfig(workspace.root, 'src/box.tsx');
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.deepEqual(
    Object.values(severities(config)).filter(
      (severity) => severity !== undefined && severity !== 0,
    ),
    [],
  );
  assert.deepEqual(
    findings.filter(({ ruleId }) => STRICT_RULES.includes(ruleId ?? '')),
    [],
  );
});
