import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-captured-assignment.ts';

const reported = [{ messageId: 'capturedAssignment' }];

test('no-captured-assignment reports a nested function that assigns a variable of an enclosing function', () => {
  typescriptRuleTester().run('no-captured-assignment', rule, {
    valid: [
      // A function assigns its own variables, also in a loop or a block.
      { code: `function f() { let n = 0; n += 1; return n; }` },
      {
        code: `function f(items: number[]) { let total = 0; for (const item of items) { total += item; } return total; }`,
      },
      // A generator assigns its own local between yields (Apple Notes' nextLaunch).
      {
        code: `async function* read(launches: AsyncIterable<number>) { let next = 0; for await (const launch of launches) { next = launch; yield next; } }`,
      },
      // A nested function assigns its own variables and parameters.
      {
        code: `function f() { return (x: number) => { let y = x; y += 1; x = y; return x; }; }`,
      },
      // A nested function reads a captured variable.
      { code: `function f() { let n = 0; n = 1; return () => n; }` },
      // A module-scope binding belongs to functional/no-let.
      { code: `let count = 0; export function next() { return ++count; }` },
      // A member assignment or a mutation of a captured object needs types.
      {
        code: `function f() { const state = { n: 0 }; return () => { state.n += 1; }; }`,
      },
      {
        code: `function f() { const seen = new Map<string, number>(); return (key: string) => { seen.set(key, 1); }; }`,
      },
      {
        code: `class A { #n = 0; start(events: { on(listener: () => void): void }) { events.on(() => { this.#n += 1; }); } }`,
      },
      // A lazy memo sets the value one time and never clears it.
      {
        code: `function lazy(read: () => string) { let value: string | undefined; return () => (value ??= read()); }`,
      },
      // A const cannot be assigned.
      { code: `function f() { const n = 0; return () => n + 1; }` },
    ],
    invalid: [
      // A promise executor: Promise.withResolvers gives the functions.
      {
        code: `function f() { let resolve: (() => void) | undefined; new Promise<void>((r) => { resolve = r; }); return resolve; }`,
        errors: reported,
      },
      // A counter in a callback: reduce, or a for...of loop.
      {
        code: `function f(items: number[]) { let total = 0; items.forEach((item) => { total += item; }); return total; }`,
        errors: reported,
      },
      {
        code: `function f(events: { on(listener: () => void): void }) { let calls = 0; events.on(() => calls++); return () => calls; }`,
        errors: reported,
      },
      // A method of a returned object.
      {
        code: `function counter() { let n = 0; return { inc() { n += 1; return n; } }; }`,
        errors: reported,
      },
      // An accessor and a method of a class that the function defines.
      {
        code: `function f() { let n = 0; return class { set value(v: number) { n = v; } reset() { n = 0; } }; }`,
        errors: [...reported, ...reported],
      },
      // A nested function declaration, and a parameter of the outer function.
      {
        code: `function f(x: number) { function g() { x = 2; } g(); return x; }`,
        errors: reported,
      },
      // A var, two levels down.
      {
        code: `function f() { var n = 0; return () => () => { n = 1; }; }`,
        errors: reported,
      },
      // A let of a block inside the outer function.
      {
        code: `function f(flag: boolean) { if (flag) { let n = 0; return () => { n--; }; } return () => {}; }`,
        errors: reported,
      },
      // A destructuring target and a loop target.
      {
        code: `function f(pair: [number, number]) { let a = 0; let b = 0; const set = () => { [a, { b }] = [pair[0], { b: pair[1] }]; }; set(); return a + b; }`,
        errors: [...reported, ...reported],
      },
      {
        code: `function f(items: string[]) { let last = ''; return () => { for (last of items); return last; }; }`,
        errors: reported,
      },
      // An IIFE, sync or async: return the value from it.
      {
        code: `function f() { let n = 0; (() => { n = 1; })(); return n; }`,
        errors: reported,
      },
      {
        code: `async function f() { let failure: unknown; await (async () => { try { await Promise.resolve(); } catch (error) { failure = error; } })(); return failure; }`,
        errors: reported,
      },
      // ||= and &&= can set the value again, unlike ??=.
      {
        code: `function f(read: () => string) { let value = ''; return () => (value ||= read()); }`,
        errors: reported,
      },
    ],
  });
});
