import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const RULE = 'zukhruf/no-silent-catch';

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
        lib: ['dom', 'es2024', 'esnext.disposable'],
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
      /^This catch drops the error, so nobody sees the failure\. In test cleanup, use `await using` with `AsyncDisposableStack\.defer\(cleanup\)`/,
    );
  }
  return own.map(({ line }) => line);
}

test('a rejection callback that returns nothing on a promise made in the same expression is reported, in .catch and as the second argument of .then', async () => {
  // Act
  const lines = await reportedLines('cleanup.ts', [
    `declare const stop: () => Promise<void>, make: () => Promise<number>;`,
    `await stop().catch(() => {});`,
    `await stop().catch(() => undefined);`,
    `await stop().catch(() => null);`,
    `await stop().catch(() => void 0);`,
    `await stop().catch(function () {});`,
    `await new Promise<void>((resolve) => resolve()).catch(() => {});`,
    `await make().then((n) => n + 1, () => undefined);`,
  ]);

  // Assert
  assert.deepStrictEqual(lines, [2, 3, 4, 5, 6, 7, 8]);
});

test('an empty catch block is reported, also when a comment gives a reason', async () => {
  // Act
  const lines = await reportedLines('read.ts', [
    `declare const read: () => string;`,
    `try { read(); } catch {}`,
    `try {`,
    `  read();`,
    `} catch (error) {`,
    `  // the file may not exist yet`,
    `}`,
  ]);

  // Assert
  assert.deepStrictEqual(lines, [2, 5]);
});

test('a catch that handles the error, and a stored promise marked handled, are not reported', async () => {
  // Act
  const lines = await reportedLines('handled.ts', [
    `declare const stop: () => Promise<void>, report: (error: unknown) => void;`,
    `declare const codeOf: (error: unknown) => string | undefined;`,
    `await stop().catch((error: unknown) => { if (codeOf(error) !== 'ENOENT') throw error; });`,
    `await stop().catch(report);`,
    `await stop().catch((error: unknown) => report(error));`,
    `await stop().then(() => undefined);`,
    `const running = stop();`,
    `running.catch(() => undefined);`,
    `try { await stop(); } catch (error) { report(error); }`,
    `await using cleanup = new AsyncDisposableStack();`,
    `cleanup.defer(stop);`,
    `await running;`,
  ]);

  // Assert
  assert.deepStrictEqual(lines, []);
});
