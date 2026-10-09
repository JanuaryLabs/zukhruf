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
    // A library's types: the rule does not look inside them, but it still
    // knows a PromiseWithResolvers that a polyfill declares.
    'node_modules/library/package.json': JSON.stringify({
      name: 'library',
      types: 'index.d.ts',
    }),
    'node_modules/library/index.d.ts': [
      'export interface PromiseWithResolvers<T> { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void; }',
      'export interface Writer { closed: Promise<void>; write(chunk: string): Promise<void>; }',
    ].join('\n'),
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
      {
        filename,
        code: `class A { readonly #pending = new Map<string, { key: string; resolve: (held: boolean) => void; reject: (reason: unknown) => void }>(); }`,
      },
      {
        filename,
        code: `class Box<T> { get ready(): Promise<T> { return new Promise(() => {}); } } class A { readonly #box = new Box<number>(); }`,
      },
      {
        filename,
        code: `class Gate { get opened(): Promise<void> { return Promise.resolve(); } } class A { readonly #gate = new Gate(); }`,
      },
      {
        filename,
        code: `import type { Writer } from 'library'; class A { #writer?: Writer; }`,
      },
      {
        filename,
        code: `interface Box<T> { item: T } interface Chain<T> { value: T; next: Chain<Box<T>> | undefined } class A { #chain?: Chain<number>; }`,
      },
      {
        filename,
        code: `interface Client { fetch(url: string): Promise<string>; load: () => Promise<number>; } class A { #client?: Client; }`,
      },
      {
        filename,
        code: `type Tree = Map<string, Tree>; class A { #tree?: Tree; }`,
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
      {
        filename,
        code: `class A { readonly #ended = Promise.withResolvers<number>(); }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { readonly #pending = new Map<string, PromiseWithResolvers<number>>(); }`,
        errors: reported,
      },
      {
        filename,
        code: `import type { PromiseWithResolvers } from 'library'; class A { #ended?: PromiseWithResolvers<number>; }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #both?: { id: string } & Map<string, Promise<number>>; }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { readonly #cache: Record<string, Promise<number>> = {}; }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #some: Partial<Record<'a' | 'b', Promise<number>>> = {}; }`,
        errors: reported,
      },
      {
        filename,
        code: `interface Query { key: string; answer: Promise<boolean>; } class A { #query?: Query; }`,
        errors: reported,
      },
      {
        filename,
        code: `type Pending = { key: string; answer: PromiseWithResolvers<number> }; class A { readonly #pending = new Map<string, Pending>(); }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #state?: { inner: { ready: Promise<void> } }; }`,
        errors: reported,
      },
      {
        filename,
        code: `interface Q { p: Promise<number> } class A { #deep?: { x: { y: { z: { w: Q } } }; q: Q }; }`,
        errors: reported,
      },
      {
        filename,
        code: `interface Q { p: Promise<number> } class A { #deep?: { q: Q; x: { y: { z: { w: Q } } } }; }`,
        errors: reported,
      },
      {
        filename,
        code: `interface Handle { get ready(): Promise<void>; } class A { #handle?: Handle; }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #byKey: { [key: string]: Promise<number> } = {}; }`,
        errors: reported,
      },
      {
        filename,
        code: `interface Query { answer: Promise<boolean> } class A { #query?: Readonly<Query>; }`,
        errors: reported,
      },
      {
        filename,
        code: `interface Query { key: string; answer: Promise<boolean> } class A { #query?: Pick<Query, 'answer'>; }`,
        errors: reported,
      },
      {
        filename,
        code: `interface Lookup { answer?: Promise<boolean> } class A { #lookup?: Lookup; }`,
        errors: reported,
      },
      {
        filename,
        code: `interface Writer { closed: Promise<void>; write(chunk: string): Promise<void>; } class A { #writer?: Writer; }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #deep?: { a: { b: { c: { d: Promise<number> } } } }; }`,
        errors: reported,
      },
      {
        filename,
        code: `interface Job { (): void; done: Promise<void>; } class A { #job?: Job; }`,
        errors: reported,
      },
    ],
  });
});
