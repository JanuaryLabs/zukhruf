import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { scratchDirectory } from './testing/scratch-directory.ts';

const README = fileURLToPath(new URL('../README.md', import.meta.url));
const TSCONFIG = fileURLToPath(
  new URL('../tsconfig.lib.json', import.meta.url),
);
const INDEX = fileURLToPath(new URL('index.ts', import.meta.url));
const ENGINE_API = fileURLToPath(new URL('engine-api.ts', import.meta.url));

/** The type arguments of each generic declaration of the README, for its check. */
const TYPE_ARGUMENTS: Record<string, string> = { Created: "<'key', 1, 2>" };

/** The declarations of the `## API` block of the README, with the kind and the name of each. */
async function readmeApi(): Promise<{
  source: string;
  declarations: { kind: string; name: string }[];
}> {
  const readme = await readFile(README, 'utf8');
  const block = /^## API\n\n```ts\n([\s\S]*?)\n```$/m.exec(readme)?.[1];
  assert.ok(block, 'The README has no ## API block.');
  const source = block.replace(/^export type \* as EngineApi from .*$/m, '');
  const declarations = [
    ...source.matchAll(/^export (class|interface|type) (\w+)/gm),
  ].map(([, kind = '', name = '']) => ({ kind, name }));
  return { source, declarations };
}

/**
 * One check of a declaration of the README against the export of the package.
 * The package must give at least what the README declares, with the same
 * public members. A type alias must be the same type in both directions.
 */
function check(kind: string, name: string): string {
  const typeArguments = TYPE_ARGUMENTS[name] ?? '';
  const readme = `Readme.${name}${typeArguments}`;
  const actual = `Package.${name}${typeArguments}`;
  if (kind === 'type') {
    return `type Check${name} = [Expect<Assignable<${actual}, ${readme}>>, Expect<Assignable<${readme}, ${actual}>>];`;
  }
  const checks = [
    `Expect<Assignable<${actual}, ${readme}>>`,
    `Expect<Equal<keyof ${actual}, keyof ${readme}>>`,
  ];
  if (kind === 'class') {
    const statics = `Exclude<keyof typeof Readme.${name}, 'prototype'>`;
    checks.push(
      `Expect<Assignable<Pick<typeof Package.${name}, ${statics}>, Pick<typeof Readme.${name}, ${statics}>>>`,
    );
  }
  return `type Check${name} = [${checks.join(', ')}];`;
}

test('each declaration of the README API block is exported from the package, and the package is assignable to it with the same public members', async () => {
  // Arrange
  await using scratch = await scratchDirectory();
  const { source, declarations } = await readmeApi();
  const file = join(scratch.path, 'readme-api.mts');
  await writeFile(
    file,
    [
      `import type * as Package from ${JSON.stringify(INDEX)};`,
      `import type * as EngineApi from ${JSON.stringify(ENGINE_API)};`,
      `type EngineApiOfPackage = Package.EngineApi.ContainerCreateRequest;`,
      'type Expect<T extends true> = T;',
      // An `any` from a broken export would pass each check, so it fails here.
      'type Assignable<A, B> = 0 extends 1 & A ? false : [A] extends [B] ? true : false;',
      'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;',
      `declare namespace Readme {\n${source}\n}`,
      ...declarations.map(({ kind, name }) => check(kind, name)),
    ].join('\n'),
  );
  const config = ts.getParsedCommandLineOfConfigFile(
    TSCONFIG,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        );
      },
    },
  );
  assert.ok(config);

  // Act
  const program = ts.createProgram([file], {
    ...config.options,
    noEmit: true,
    composite: false,
    declaration: false,
    declarationMap: false,
    rootDir: '/',
    noUnusedLocals: false,
    rewriteRelativeImportExtensions: false,
  });
  const diagnostics = ts.getPreEmitDiagnostics(
    program,
    program.getSourceFile(file),
  );

  // Assert
  assert.ok(declarations.length > 40, `${declarations.length} declarations`);
  assert.equal(
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => scratch.path,
      getNewLine: () => '\n',
    }),
    '',
  );
});
