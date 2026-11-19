import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Rule } from 'eslint';
import * as ts from 'typescript';

import { isAstNode } from '../authoring/ast.ts';
import { projectOf } from '../workspace/project-manifest.ts';

const VITEST_CONFIG = /^vitest\.config\.(?:js|ts|mjs|mts|cjs|cts)$/;
const VITE_CONFIG = /^vite\.config\.(?:js|ts|mjs|mts|cjs|cts)$/;
const NODE_TEST = new Set(['node:test', 'test']);

interface Parsed {
  readonly mtimeMs: number;
  readonly hasTest: boolean;
}

// Keyed by absolute path. A changed mtime re-parses, so a long-lived ESLint
// process (an editor) sees an edit.
const parsedByFile = new Map<string, Parsed>();

function isTestKey(node: ts.Node): boolean {
  return (
    (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
    ts.isIdentifier(node.name) &&
    node.name.text === 'test' &&
    (ts.isShorthandPropertyAssignment(node) ||
      !ts.isRegularExpressionLiteral(node.initializer))
  );
}

function hasTestKey(node: ts.Node): boolean {
  return isTestKey(node) || ts.forEachChild(node, hasTestKey) === true;
}

/** Whether the vite config at `file` sets `test`, the key Vitest reads, other than a plugin's `test: /regex/` filter. */
function viteConfigHasTest(file: string): boolean {
  const { mtimeMs } = statSync(file);
  const cached = parsedByFile.get(file);
  if (cached?.mtimeMs === mtimeMs) return cached.hasTest;
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const hasTest = hasTestKey(source);
  parsedByFile.set(file, { mtimeMs, hasTest });
  return hasTest;
}

/**
 * Whether the project at `root` is a Vitest project, by the rule of
 * `@nx/vitest` that `@zukhruf/nx/test` follows (its ADR 0004): it has a
 * `vitest.config.*`, or a `vite.config.*` that sets `test`. Every other
 * project runs its test files with `node --test`.
 */
function isVitestProject(root: string): boolean {
  const files = readdirSync(root);
  return (
    files.some((name) => VITEST_CONFIG.test(name)) ||
    files.some(
      (name) => VITE_CONFIG.test(name) && viteConfigHasTest(join(root, name)),
    )
  );
}

/**
 * A project has one test runner, the one its config picks. A test file that
 * imports the other runner is either never run (a node:test file under a
 * Vitest `include`) or needs a second collection, reporter and target for one
 * project. Switch the file to the project's runner.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow a test file that imports a test runner other than its project's: Vitest in a Vitest project, node:test in every other",
    },
    schema: [],
    messages: {
      nodeTestInVitest:
        "This project runs Vitest: it has a vitest.config or a vite.config that sets test. A node:test file here runs under neither runner's target, or needs a second one. Import test and assertions from 'vitest' like the project's other test files.",
      vitestOutsideVitest:
        "This project runs its tests with node --test: it has no vitest.config and no vite.config that sets test. Import test from 'node:test' and assert from 'node:assert/strict'; a project that needs Vitest (a DOM environment) sets test in its vite.config.",
    },
  },
  create(context) {
    const project = projectOf(context.physicalFilename);
    if (project === undefined) return {};
    return {
      ImportDeclaration(node) {
        // `import type` is erased: it runs no test.
        if (isAstNode(node) && node['importKind'] === 'type') return;
        const source = node.source.value;
        if (source !== 'vitest' && !NODE_TEST.has(String(source))) return;
        const vitest = isVitestProject(project.root);
        if (vitest && source !== 'vitest') {
          context.report({ node, messageId: 'nodeTestInVitest' });
        } else if (!vitest && source === 'vitest') {
          context.report({ node, messageId: 'vitestOutsideVitest' });
        }
      },
    };
  },
};

export default rule;
