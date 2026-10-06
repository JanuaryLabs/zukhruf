import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import type { Rule } from 'eslint';
import ignore, { type Ignore } from 'ignore';

import { type AstNode, isType } from '../authoring/ast.ts';
import { workspaceRootOf } from '../workspace/workspace-root.ts';

function keyName(property: AstNode): string | undefined {
  const key = property['key'];
  if (isType(key, 'JSONLiteral') && typeof key['value'] === 'string') {
    return key['value'];
  }
  if (isType(key, 'JSONIdentifier') && typeof key['name'] === 'string') {
    return key['name'];
  }
  return undefined;
}

function stringValue(node: unknown): string | undefined {
  return isType(node, 'JSONLiteral') && typeof node['value'] === 'string'
    ? node['value']
    : undefined;
}

const GLOB_MAGIC = /[*?[\]{}!]/;

// The leading magic-free directory of a glob pattern — 'packages/x/**' → 'packages/x'.
function staticBase(pattern: string): string {
  const segments = pattern.split('/');
  const literal: string[] = [];
  for (const segment of segments) {
    if (GLOB_MAGIC.test(segment)) {
      break;
    }
    literal.push(segment);
  }
  return literal.join('/');
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

// Nx executors generally receive workspace-root asset inputs, while Nx's Vite
// copy plugin receives project-root inputs and remaps them before
// CopyAssetsHandler runs, so both roots are tried.
function assetRoots(workspaceRoot: string, filename: string): string[] {
  const projectRoot = dirname(filename);
  if (projectRoot === workspaceRoot) {
    return [workspaceRoot];
  }
  return [workspaceRoot, projectRoot];
}

// Nx's CopyAssetsHandler reads only the ROOT .gitignore and .nxignore
// (node_modules/@nx/js/dist/src/utils/assets/copy-assets-handler.js:47-48) and
// skips every matched file (:152), so an ignored asset builds green and ships
// nothing. Nested .gitignore files are not read there, so they do not count here.
// Only the @nx/js tsc/swc executors accept includeIgnoredFiles; this rule does
// not honor that opt-out.
function rootIgnoreFiles(
  workspaceRoot: string,
): Array<{ file: string; matcher: Ignore }> {
  return ['.gitignore', '.nxignore']
    .filter((file) => existsSync(join(workspaceRoot, file)))
    .map((file) => ({
      file,
      matcher: ignore().add(readFileSync(join(workspaceRoot, file), 'utf8')),
    }));
}

/**
 * Nx copies a target's `assets` with a silent glob: an input that does not
 * exist, or one the root ignore files drop, copies nothing while the build
 * stays green, and the artifact ships without it.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow target asset entries whose input path does not exist — Nx's asset copy is a silent glob, so a dead path ships nothing while the build stays green",
    },
    messages: {
      missingInput:
        'Asset input "{{path}}" is not a directory from the workspace root or project root. The executor globs it silently — a dead input copies nothing and the build stays green. Fix the path or delete the entry.',
      missingPattern:
        'Asset pattern "{{pattern}}" matches nothing: "{{base}}" does not exist relative to the workspace root or project root. Fix the path or delete the entry.',
      ignoredAsset:
        'Asset "{{path}}" is matched by the root {{file}}, and Nx\'s asset copy skips root-ignored files — the build stays green and ships without it. Ignore it from a .gitignore inside the project instead, or stop ignoring it.',
    },
    schema: [],
  },
  create(context) {
    const filename = context.physicalFilename;
    const workspaceRoot = workspaceRootOf(dirname(filename));
    if (!workspaceRoot) {
      return {};
    }
    const roots = assetRoots(workspaceRoot, filename);
    const ignoreFiles = rootIgnoreFiles(workspaceRoot);

    // Nx globs from the workspace root, so a root that resolves the path above
    // it (a project-root `../..` read from the workspace root) is never Nx's.
    const rootResolving = (
      path: string,
      exists: (absolute: string) => boolean,
    ): string | undefined =>
      roots.find((root) => {
        const absolute = resolve(root, path);
        return (
          !relative(workspaceRoot, absolute).startsWith('..') &&
          exists(absolute)
        );
      });

    // A magic-free pattern names one path; a glob is probed at its static base
    // directory, which is ignored only when every file it can match is dropped.
    const reportIfIgnored = (
      node: AstNode,
      root: string,
      pattern: string,
    ): void => {
      const base = staticBase(pattern);
      const fromWorkspace =
        relative(workspaceRoot, resolve(root, base)) +
        (base === pattern ? '' : '/');
      const matched = ignoreFiles.find(({ matcher }) =>
        matcher.ignores(fromWorkspace),
      );
      if (matched) {
        context.report({
          node,
          messageId: 'ignoredAsset',
          data: { path: fromWorkspace, file: matched.file },
        });
      }
    };

    function underTargets(node: Rule.Node): boolean {
      return context.sourceCode
        .getAncestors(node)
        .some(
          (ancestor) =>
            isType(ancestor, 'JSONProperty') && keyName(ancestor) === 'targets',
        );
    }

    function checkStringEntry(element: AstNode): void {
      const pattern = stringValue(element);
      if (pattern === undefined) {
        return;
      }
      const normalized = pattern.replace(/^\.\//, '');
      const base = staticBase(normalized);
      if (base === '') {
        return;
      }
      const baseRoot = rootResolving(base, existsSync);
      if (!baseRoot) {
        context.report({
          node: element,
          messageId: 'missingPattern',
          data: { pattern, base },
        });
        return;
      }
      reportIfIgnored(element, baseRoot, normalized);
    }

    function checkObjectEntry(element: AstNode): void {
      const properties = element['properties'];
      if (!Array.isArray(properties)) {
        return;
      }
      const fields = new Map<string, unknown>();
      for (const property of properties) {
        if (isType(property, 'JSONProperty')) {
          const key = keyName(property);
          if (key !== undefined) {
            fields.set(key, property['value']);
          }
        }
      }
      const value = fields.get('input');
      if (!isType(value, 'JSONLiteral')) {
        return;
      }
      const input = stringValue(value);
      if (input === undefined) {
        return;
      }
      const inputRoot = rootResolving(input, isDirectory);
      if (!inputRoot) {
        context.report({
          node: value,
          messageId: 'missingInput',
          data: { path: input },
        });
        return;
      }
      const glob = stringValue(fields.get('glob'));
      if (glob !== undefined) {
        reportIfIgnored(element, inputRoot, join(input, glob));
      }
    }

    return {
      JSONProperty(node: Rule.Node) {
        if (!isType(node, 'JSONProperty')) {
          return;
        }
        if (keyName(node) !== 'assets' || !underTargets(node)) {
          return;
        }
        const value = node['value'];
        if (!isType(value, 'JSONArrayExpression')) {
          return;
        }
        const elements = value['elements'];
        if (!Array.isArray(elements)) {
          return;
        }
        for (const element of elements) {
          if (isType(element, 'JSONLiteral')) {
            checkStringEntry(element);
          } else if (isType(element, 'JSONObjectExpression')) {
            checkObjectEntry(element);
          }
        }
      },
    };
  },
};

export default rule;
