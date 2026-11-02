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

test('no-phase-flag', async () => {
  await using workspace = await fixtureWorkspace({
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
        code: `class A { #value: string | null; constructor() { this.#value = null; } }`,
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
        code: `function first(items: string[]) { let found: string | undefined; items.forEach((item) => { found ??= item; }); return { found }; }`,
      },
      {
        filename,
        code: `function pick(early: boolean) { let x: string | undefined; if (early) x = 'a'; return { x }; }`,
      },
      {
        filename,
        code: `function all(items: string[]) { let last: string | undefined; return items.map((item) => { last = item; return item + (last ?? ''); }); }`,
      },
      {
        filename,
        code: `function f() { let x: string | undefined; return (x = 'a'); }`,
      },
      {
        filename,
        code: `function f() { let x: string | undefined; const g = () => { return (x = 'a'); }; g(); return x; }`,
      },
      {
        filename,
        code: `function counter() { let n = 0; return { inc() { n += 1; return n; } }; }`,
      },
      {
        filename,
        code: `function lazy(read: () => string) { let value: { readonly read: string } | null = null; return () => (value ??= { read: read() }).read; }`,
      },
      {
        filename,
        code: `function cached() { let cache: Map<string, string> | undefined; return { get(): Map<string, string> { cache ??= new Map(); return cache; } }; }`,
      },
      {
        filename,
        code: `class A { #ready = false; } class B { #ready = 0; set() { this.#ready = 1; } }`,
      },
      {
        filename,
        code: `class A { #events?: string[]; get events(): string[] { this.#events ??= ['a']; return this.#events; } }`,
      },
      {
        filename,
        code: `class A { #ids: Set<string> | undefined; ids(): Set<string> { return (this.#ids ??= new Set(['a'])); } }`,
      },
      {
        filename,
        code: `class A { #rules?: string[] | null; rules(): string[] { this.#rules ??= ['a']; return this.#rules; } }`,
      },
      {
        filename,
        code: `class A { #ids?: Set<string>; has(id: string): boolean { this.#ids ??= new Set(['a']); return this.#ids.has(id); } }`,
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
      // A null that the first use replaces is the same phase as undefined.
      {
        filename,
        code: `interface Chat { id: string } class A { #chat: Chat | null = null; open() { this.#chat = { id: 'main' }; } }`,
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
      {
        filename,
        code: `class A { #x?: string[]; get x(): string[] { this.#x ??= ['a']; return this.#x; } clear() { this.#x = undefined; } }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #x?: string[]; get x(): string[] { this.#x ??= ['a']; return this.#x; } loaded() { if (this.#x) return true; return false; } }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #x?: string[]; get x(): string[] { this.#x ??= ['a']; return this.#x; } set(x: string[]) { this.#x = x; } }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #x?: string[]; constructor(x?: string[]) { this.#x = x; } get x(): string[] { this.#x ??= ['a']; return this.#x; } }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #x?: string[]; get x(): string[] { const before = this.#x; this.#x ??= ['a']; return before ?? this.#x; } }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #x?: string[]; get x(): () => string[] | undefined { this.#x ??= ['a']; const read = () => this.#x; return read; } }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #x?: string[]; get x(): string[] { if (Math.random() > 0.5) { this.#x ??= ['a']; } return this.#x ?? []; } }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { x?: string[]; get value(): string[] { this.x ??= ['a']; return this.x; } }`,
        errors: reported,
      },
      {
        filename,
        code: `class A { #x?: string[]; get x(): string[] { this.#x ??= ['a']; return this.#x; } reset(other: A) { other.#x = undefined; } }`,
        errors: reported,
      },
      {
        filename,
        code: `interface Host { id: string } function create() { let host: Host | undefined; const current = () => { if (!host) throw new Error('initialize first'); return host; }; return { current, initialize(runtimeHost: Host) { host = runtimeHost; } }; }`,
        errors: [{ messageId: 'phaseVariable', line: 1, column: 55 }],
      },
      {
        filename,
        code: `interface Chat { id: string } function create() { let chat: Chat | null = null; return (next: Chat) => { chat = next; return chat.id; }; }`,
        errors: [{ messageId: 'phaseVariable', line: 1, column: 55 }],
      },
      {
        filename,
        code: `function connection() { let closed = false; return { close() { closed = true; }, get open() { return !closed; } }; }`,
        errors: [{ messageId: 'phaseVariable' }],
      },
      {
        filename,
        code: `function cached() { let cache: Map<string, string> | undefined; return { get() { return (cache ??= new Map()); }, clear() { cache = undefined; } }; }`,
        errors: [{ messageId: 'phaseVariable' }],
      },
      {
        filename,
        code: `function cached() { let cache: Map<string, string> | undefined; return { get(): Map<string, string> { cache ??= new Map(); return cache; }, loaded() { return cache !== undefined; } }; }`,
        errors: [{ messageId: 'phaseVariable' }],
      },
      {
        filename,
        code: `function f() { let x: string | undefined; return [() => { x = 'a'; }]; }`,
        errors: [{ messageId: 'phaseVariable' }],
      },
      {
        filename,
        code: `function f() { let x: string | undefined; return class { set() { x = 'a'; } }; }`,
        errors: [{ messageId: 'phaseVariable' }],
      },
      {
        filename,
        code: `function f() { let x: string | undefined; return class { set = () => { x = 'a'; }; }; }`,
        errors: [{ messageId: 'phaseVariable' }],
      },
      {
        filename,
        code: `function f() { let x: string | undefined; return { set(v: string) { x = v; } } as const; }`,
        errors: [{ messageId: 'phaseVariable' }],
      },
      {
        filename,
        code: `function f() { let x: string | undefined; return { set(v: string) { x = v; } } satisfies { set(v: string): void }; }`,
        errors: [{ messageId: 'phaseVariable' }],
      },
    ],
  });
});
