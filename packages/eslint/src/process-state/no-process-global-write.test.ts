import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const RULE = 'zukhruf/no-process-global-write';

/** Lints `src/<file>`, holding `lines`, with `zukhruf/base`, and returns the line of each finding of the rule. */
async function reportedLines(file: string, lines: string[]): Promise<number[]> {
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    // `types: []` keeps the fixture from loading @types the temporary folder does not have.
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        types: [],
        lib: ['dom', 'es2024'],
      },
      include: ['**/*.ts'],
    }),
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/base'] }`,
    ),
    [`src/${file}`]: `${lines.join('\n')}\n`,
  });
  const own = lint(workspace.root, [`src/${file}`]).filter(
    ({ ruleId }) => ruleId === RULE,
  );
  for (const { message } of own) {
    assert.match(
      message,
      /^console is one object for the whole process: .* in a test, use t\.mock\.method\(console, …\)/,
    );
  }
  return own.map(({ line }) => line);
}

test('shipped code that replaces console or one of its methods is reported: an assignment, also through the global object, and Object.assign or defineProperty on it', async () => {
  // Act
  const lines = await reportedLines('logger.ts', [
    `declare let console: Console;`,
    `declare const send: (args: unknown[]) => void, other: Console;`,
    `console.error = (...args: unknown[]) => send(args);`,
    `console['warn'] = (...args: unknown[]) => send(args);`,
    `console = other;`,
    `globalThis.console = other;`,
    `globalThis.console.log = (...args: unknown[]) => send(args);`,
    `window.console.info ??= () => undefined;`,
    `Object.assign(console, { debug: () => undefined });`,
    `Object.defineProperty(globalThis.console, 'trace', { value: () => undefined });`,
    `Object.defineProperties(console, {});`,
  ]);

  // Assert
  assert.deepEqual(lines, [3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('a test that swaps console.error by hand is reported too', async () => {
  // Act
  const lines = await reportedLines('logger.test.ts', [
    `const original = console.error;`,
    `console.error = () => undefined;`,
    `console.error = original;`,
  ]);

  // Assert
  assert.deepEqual(lines, [2, 3]);
});

test('reading console, also into an assignment, calling it, mocking it for one test, and writing a console field of another object are not reported', async () => {
  // Act
  const lines = await reportedLines('logger.test.ts', [
    `declare const t: { mock: { method(target: object, name: string): void } };`,
    `declare const logger: { console: Console };`,
    `console.log('ready');`,
    `const { warn } = console;`,
    `const copy = Object.assign({}, console);`,
    `t.mock.method(console, 'error');`,
    `logger.console = copy;`,
    `logger.console.log = warn;`,
    `let current: unknown;`,
    `current = console.warn;`,
  ]);

  // Assert
  assert.deepEqual(lines, []);
});
