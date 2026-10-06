import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { typedRuleTester } from '../testing/rule-tester.ts';
import rule from './no-phase-flag.ts';

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

const reported = [{ messageId: 'phaseFlag' }];

test('no-phase-flag', () => {
  using workspace = fixtureWorkspace({
    'tsconfig.json': tsconfig,
    'index.ts': 'export {};\n',
  });
  const filename = workspace.path('fields.ts');

  typedRuleTester(workspace.root).run('no-phase-flag', rule, {
    valid: [
      { filename, code: `class A { readonly #ready = false; }` },
      {
        filename,
        code: `class A { #ready: boolean; constructor(ready: boolean) { this.#ready = ready; } }`,
      },
      {
        filename,
        code: `class A { #value: string | undefined; constructor() { this.#value = undefined; } }`,
      },
      {
        filename,
        code: `class A { #count = 0; next() { this.#count += 1; } }`,
      },
      {
        filename,
        code: `interface Phase { name: string } class A { #phase: Phase = { name: 'idle' }; open() { this.#phase = { name: 'open' }; } }`,
      },
      {
        filename,
        code: `class A { static #ready = false; static start() { this.#ready = true; } }`,
      },
      {
        filename,
        code: `function f() { let done = false; done = true; return done; }`,
      },
      {
        filename,
        code: `class A { #ready = false; } class B { #ready = 0; set() { this.#ready = 1; } }`,
      },
    ],
    invalid: [
      {
        filename,
        code: `class A { #closed = false; close() { this.#closed = true; } }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #current: string | undefined; open() { this.#current = 'x'; } }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #value?: number; set() { this.#value = 1; } }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #ready: boolean | undefined; load() { this.#ready ??= true; } }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #exited = false; readonly #onExit = () => { this.#exited = true; }; }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #exited = false; constructor(worker: { on(event: string, listener: () => void): void }) { worker.on('exit', () => { this.#exited = true; }); } }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { constructor(private ready: boolean) {} reset() { this.ready = false; } }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { connected = false; connect() { this.connected = true; } }`,
        errors: reported,
      },
      {
        filename,
        code: `type Role = 'leader' | 'follower'; class A { #role: Role | undefined; lead() { this.#role = 'leader'; } }`,
        errors: reported,
      },
    ],
  });
});
