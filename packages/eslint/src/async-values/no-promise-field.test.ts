import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { typedRuleTester } from '../testing/rule-tester.ts';
import rule from './no-promise-field.ts';

// `types: []` keeps the fixture from loading @types the temporary folder does
// not have. TypeScript rejects a tsconfig that matches no file, so the fixture
// holds one module; the cases themselves never touch the disk.
const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: 'esnext',
    lib: ['esnext'],
    types: [],
  },
  include: ['index.ts'],
});

const reported = [{ messageId: 'promiseField' }];

test('no-promise-field', () => {
  using workspace = fixtureWorkspace({
    'tsconfig.json': tsconfig,
    'index.ts': 'export {};\n',
  });
  const filename = workspace.path('fields.ts');

  typedRuleTester(workspace.root).run('no-promise-field', rule, {
    valid: [
      { filename, code: `class A { #count = 0; }` },
      {
        filename,
        code: `class A { readonly #load: () => Promise<number> = async () => 1; }`,
      },
      {
        filename,
        code: `class A { readonly #loaders = new Map<string, () => Promise<number>>(); }`,
      },
      { filename, code: `interface Store { ready: Promise<void>; }` },
      {
        filename,
        code: `async function f() { const p: Promise<void> = Promise.resolve(); await p; }`,
      },
    ],
    invalid: [
      {
        filename,
        code: `class A { #ready: Promise<void> = Promise.resolve(); }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { readonly #ready = Promise.resolve(); }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #connection: Promise<string> | undefined; }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { readonly #cache = new Map<string, Promise<number>>(); }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #all: Promise<number>[] = []; }`,
        errors: reported,
      },
      {
        filename,
        code: `type Pending = Promise<number>; class A { #pending?: Pending; }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #settled = this.#connect(); async #connect() {} }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #like?: PromiseLike<number>; }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { accessor ready = Promise.resolve(); }`,
        errors: reported,
      },
      {
        filename,
        code: `abstract class A { abstract ready: Promise<void>; }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { constructor(private readonly ready: Promise<void>) {} }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { static shared = Promise.resolve(1); }`,
        errors: reported,
      },
    ],
  });
});
