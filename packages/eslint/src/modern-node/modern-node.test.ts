import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

function recommendedConfig(): string {
  return [
    `import { defineConfig } from '${import.meta.resolve('eslint/config')}';`,
    `import modernNode from '${import.meta.resolve('@zukhruf/eslint/modern-node')}';`,
    `export default defineConfig({`,
    `  plugins: { 'modern-node': modernNode },`,
    `  extends: ['modern-node/recommended'],`,
    `});`,
  ].join('\n');
}

test('modern-node/recommended reports each check it turns on', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'eslint.config.mjs': recommendedConfig(),
    'src/modern-node-crypto-hash.js': `import { createHash } from 'node:crypto';\nexport const a = createHash('sha256').update('x').digest('hex');`,
    'src/e18e-prefer-array-at.js': `export const a = (x) => x[x.length - 1];`,
    'src/e18e-prefer-array-to-reversed.js': `export const a = (s) => [...s].reverse();`,
    'src/e18e-prefer-array-to-sorted.js': `export const a = (s) => [...s].sort();`,
    'src/e18e-prefer-exponentiation-operator.js': `export const a = (x) => Math.pow(x, 2);`,
    'src/e18e-prefer-flatmap-over-map-flat.js': `export const a = (x, f) => x.map(f).flat();`,
    'src/e18e-prefer-includes.js': `export const a = (x, v) => x.indexOf(v) !== -1;`,
    'src/e18e-prefer-nullish-coalescing.js': `export const a = (x, y) => (x === null || x === undefined ? y : x);`,
    'src/e18e-prefer-object-has-own.js': `export const a = (x, k) => x.hasOwnProperty(k);`,
    'src/e18e-prefer-url-canparse.js': `export const a = (x) => { try { new URL(x); return true; } catch { return false; } };`,
    'src/unicorn-no-new-buffer.js': `export const a = () => new Buffer(1);`,
    'src/unicorn-prefer-abort-signal-any.js': `export function a(userSignal, timeSignal) { const c = new AbortController(); userSignal.addEventListener('abort', () => c.abort()); timeSignal.addEventListener('abort', () => c.abort()); return c.signal; }`,
    'src/unicorn-prefer-array-from-async.js': `export const a = async (source) => { const items = []; for await (const item of source) items.push(item); return items; };`,
    'src/unicorn-prefer-error-is-error.js': `export const a = (e) => e instanceof Error;`,
    'src/unicorn-prefer-group-by.js': `export const a = (xs) => { const g = {}; for (const x of xs) { (g[x.k] ??= []).push(x); } return g; };`,
    'src/unicorn-prefer-import-meta-properties.js': `import { dirname } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nexport const a = dirname(fileURLToPath(import.meta.url));`,
    'src/unicorn-prefer-iterator-helpers.js': `export const a = (m) => [...m.values()].some((x) => x);`,
    'src/unicorn-prefer-promise-with-resolvers.js': `let resolve;\nexport const a = new Promise((r) => { resolve = r; });\nresolve();`,
    'src/unicorn-prefer-set-methods.js': `const a = new Set(x);\nconst b = new Set(y);\nexport const all = new Set([...a, ...b]);`,
    'src/unicorn-prefer-url-search-parameters.js': `export const a = (search) => Object.fromEntries(search.slice(1).split('&').map((pair) => pair.split('=')));`,
    'src/unicorn-prefer-uint8array-hex.js': `export const a = (b) => Buffer.from(b).toString('hex');`,
  });

  // Act
  const findings = lint(workspace.root, ['.']);

  // Assert
  const reported = findings
    .map(({ file, ruleId }) => `${basename(file, '.js')} ${ruleId}`)
    .sort();
  assert.deepEqual(reported, [
    'e18e-prefer-array-at e18e/prefer-array-at',
    'e18e-prefer-array-to-reversed e18e/prefer-array-to-reversed',
    'e18e-prefer-array-to-sorted e18e/prefer-array-to-sorted',
    'e18e-prefer-exponentiation-operator e18e/prefer-exponentiation-operator',
    'e18e-prefer-flatmap-over-map-flat e18e/prefer-flatmap-over-map-flat',
    'e18e-prefer-includes e18e/prefer-includes',
    'e18e-prefer-nullish-coalescing e18e/prefer-nullish-coalescing',
    'e18e-prefer-object-has-own e18e/prefer-object-has-own',
    'e18e-prefer-url-canparse e18e/prefer-url-canparse',
    'modern-node-crypto-hash modern-node/crypto-hash',
    'unicorn-no-new-buffer unicorn/no-new-buffer',
    'unicorn-prefer-abort-signal-any unicorn/prefer-abort-signal-any',
    'unicorn-prefer-array-from-async unicorn/prefer-array-from-async',
    'unicorn-prefer-error-is-error unicorn/prefer-error-is-error',
    'unicorn-prefer-group-by unicorn/prefer-group-by',
    'unicorn-prefer-import-meta-properties unicorn/prefer-import-meta-properties',
    'unicorn-prefer-iterator-helpers unicorn/prefer-iterator-helpers',
    'unicorn-prefer-promise-with-resolvers unicorn/prefer-promise-with-resolvers',
    'unicorn-prefer-set-methods unicorn/prefer-set-methods',
    'unicorn-prefer-uint8array-hex unicorn/prefer-uint8array-hex',
    'unicorn-prefer-url-search-parameters unicorn/prefer-url-search-parameters',
  ]);
});

test('modern-node/recommended leaves off the checks that break code or fix nothing', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'eslint.config.mjs': recommendedConfig(),
    'src/spread-syntax.js': `export const a = (x, y) => x.concat(y);`,
    'src/array-fill.js': `export const a = (n) => Array.from({ length: n }, () => 0);`,
    'src/array-to-spliced.js': `export const a = (s) => [...s].splice(0, 1);`,
    'src/array-sort.js': `export const a = (o) => Object.keys(o).sort();`,
    'src/array-reverse.js': `export const a = (o) => Object.keys(o).reverse();`,
    'src/dispose.js': `export const a = (open) => { const r = open(); try { r.read(); } finally { r.close(); } };`,
    // e18e/ban-dependencies reads only the name of a package, and the code can
    // need that package, such as uuid for v5 (ADR 0008).
    'src/uuid.js': `import { v5 } from 'uuid';\nexport const a = v5;`,
    'package.json': '{ "dependencies": { "uuid": "1.0.0" } }',
    'src/abort-signal-timeout.js': `export const a = () => { const c = new AbortController(); setTimeout(() => c.abort(), 1000); return c.signal; };`,
  });

  // Act
  const findings = lint(workspace.root, ['.']);

  // Assert
  assert.deepEqual(findings, []);
});

test('unicorn/prefer-dispose reads types: a TypeScript resource with a disposer is reported, one with only close() and a JavaScript file are not', async () => {
  // Arrange
  const disposable = `class Resource { read() {} close() {} [Symbol.dispose]() {} }`;
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'package.json': '{ "name": "fixture", "type": "module" }',
    'tsconfig.json':
      '{ "compilerOptions": { "target": "esnext", "module": "nodenext", "strict": true, "types": [] }, "include": ["src"] }',
    'eslint.config.mjs': [
      `import { defineConfig } from '${import.meta.resolve('eslint/config')}';`,
      `import zukhruf from '${import.meta.resolve('@zukhruf/eslint')}';`,
      `import modernNode from '${import.meta.resolve('@zukhruf/eslint/modern-node')}';`,
      `export default defineConfig({`,
      `  plugins: { zukhruf, 'modern-node': modernNode },`,
      `  extends: ['zukhruf/base', 'modern-node/recommended'],`,
      `});`,
    ].join('\n'),
    'src/disposer.ts': `${disposable}\nexport function a() { const r = new Resource(); try { r.read(); } finally { r.close(); } }`,
    'src/only-close.ts': `class Resource { read() {} close() {} }\nexport function a() { const r = new Resource(); try { r.read(); } finally { r.close(); } }`,
    'src/disposer.mjs': `${disposable}\nexport function a() { const r = new Resource(); try { r.read(); } finally { r.close(); } }`,
  });

  // Act
  const findings = lint(workspace.root, ['.']);

  // Assert
  assert.deepEqual(
    findings
      .filter(({ ruleId }) => ruleId === 'unicorn/prefer-dispose')
      .map(({ file }) => basename(file)),
    ['disposer.ts'],
  );
});

test('zukhruf/base reports no modern-node check, so a repo gets them only when it extends the config', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'package.json': '{ "name": "fixture", "type": "module" }',
    'eslint.config.mjs': fixtureConfig(`{
      plugins: { zukhruf },
      extends: ['zukhruf/base'],
    }`),
    'src/app.js': `import { createHash } from 'node:crypto';\nexport const a = createHash('sha256').update('x').digest('hex');\nexport const b = (e) => e instanceof Error;\nexport const c = (x) => x[x.length - 1];`,
  });

  // Act
  const findings = lint(workspace.root, ['src/app.js']);

  // Assert
  assert.deepEqual(
    findings.filter(({ ruleId }) =>
      /^(modern-node|e18e|unicorn)\//u.test(ruleId ?? ''),
    ),
    [],
  );
});
