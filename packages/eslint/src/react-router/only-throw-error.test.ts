import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

// `types: []` keeps the fixture from loading @types the temporary folder does
// not have; `dom` declares the Response that redirect() returns.
const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: 'esnext',
    lib: ['esnext', 'dom'],
    types: [],
  },
  include: ['**/*.ts'],
});

// React Router's own declarations of the values a loader throws.
const reactRouter = {
  'node_modules/react-router/package.json': JSON.stringify({
    name: 'react-router',
    version: '8.5.0',
    types: 'index.d.ts',
  }),
  'node_modules/react-router/index.d.ts': [
    'export declare class DataWithResponseInit<D> { type: string; data: D; init: ResponseInit | null; constructor(data: D, init?: ResponseInit); }',
    'export declare function data<D>(data: D, init?: number | ResponseInit): DataWithResponseInit<D>;',
    'export type RedirectFunction = (url: string, init?: number | ResponseInit) => Response;',
    'export declare const redirect: RedirectFunction;',
    'export declare const replace: RedirectFunction;',
  ].join('\n'),
};

const thrownAt = (findings: { ruleId: string | null; file: string }[]) =>
  findings
    .filter(({ ruleId }) => ruleId === '@typescript-eslint/only-throw-error')
    .map(({ file }) => file);

test('a react-router file may throw redirect(), replace() and data(), in a loader and in a helper', async () => {
  // Arrange: the helper sits outside any routes folder, as an auth gate does.
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/base', 'zukhruf/react-router'] }`,
    ),
    ...reactRouter,
    'src/routes/chat.ts': [
      `import { data, redirect } from 'react-router';`,
      `export async function loader({ request }: { request: Request }) {`,
      `  if (!request.headers.get('cookie')) throw redirect('/login');`,
      `  if (request.method === 'DELETE') throw data({ reason: 'gone' }, 404);`,
      `  return { ok: true };`,
      `}`,
      ``,
    ].join('\n'),
    'src/auth/auth-gate.ts': [
      `import { replace } from 'react-router';`,
      `export function requiresAuth(signedIn: boolean): void {`,
      `  if (!signedIn) throw replace('/login');`,
      `}`,
      ``,
    ].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.deepEqual(thrownAt(findings), []);
});

test('a react-router file still may not throw a string or a plain object', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/base', 'zukhruf/react-router'] }`,
    ),
    ...reactRouter,
    'src/routes/text.ts': `export function loader() { throw 'text'; }\n`,
    'src/routes/object.ts': `export function loader() { throw { code: 1 }; }\n`,
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.deepEqual(thrownAt(findings).sort(), [
    workspace.path('src/routes/object.ts'),
    workspace.path('src/routes/text.ts'),
  ]);
});

test('without the react-router config, a thrown Response is still reported', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/base'] }`,
    ),
    ...reactRouter,
    'src/handler.ts': [
      `import { redirect } from 'react-router';`,
      `export function handle(): never { throw redirect('/login'); }`,
      ``,
    ].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.deepEqual(thrownAt(findings), [workspace.path('src/handler.ts')]);
});
