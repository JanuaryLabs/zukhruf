import { dirname, resolve } from 'node:path';

import type { Rule } from 'eslint';

import { type AstNode, isAstNode, isType } from '../authoring/ast.ts';
import { objectProperties } from '../authoring/json-ast.ts';
import { workspaceRootOf } from '../workspace/workspace-root.ts';

/** The sections whose packages npm installs. `peerDependencies` leaves the install to the root. */
const INSTALLED = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const;

/** A plain version with no range operator, as `npm install --save-exact` writes it. */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

interface Entry {
  readonly section: string;
  readonly name: string;
  readonly property: AstNode;
  /** The version's node, or the property's when its value is no node. */
  readonly versionNode: AstNode;
  /** The version string; empty when the value is not a string. */
  readonly version: string;
}

function isNxFamily(name: string): boolean {
  return name === 'nx' || name.startsWith('@nx/');
}

/** The nx-family entries of the sections npm installs. */
function nxFamilyEntries(manifest: AstNode): Entry[] {
  const sections = new Map(objectProperties(manifest));
  return INSTALLED.flatMap((section) =>
    objectProperties(sections.get(section)?.['value'])
      .filter(([name]) => isNxFamily(name))
      .map(([name, property]) => {
        const value = property['value'];
        return {
          section,
          name,
          property,
          versionNode: isAstNode(value) ? value : property,
          version:
            isType(value, 'JSONLiteral') && typeof value['value'] === 'string'
              ? value['value']
              : '',
        };
      }),
  );
}

/**
 * Each `@nx/*` package depends on `nx` at its own version, and `nx` ships a
 * native addon. A second version of either nests a second `nx`, with its own
 * addon, under the package that asked for it. So only the workspace root
 * installs the nx family, each package at the exact version of the root's
 * `nx`, and every other manifest names it in `peerDependencies`. The root is
 * the manifest of the folder that `workspaceRootOf` finds; a manifest outside
 * any workspace is a root itself.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require one version of nx: the workspace root pins nx and every @nx/* package to the same exact version, and other manifests name them only in peerDependencies',
    },
    schema: [],
    messages: {
      notExact:
        '{{name}} is "{{version}}", a range. The workspace root pins nx and every @nx/* package to an exact version, so a newer @nx/* package cannot bring a second nx and its native addon.',
      notEqual:
        '{{name}} is "{{version}}", but nx is "{{nx}}". Each @nx/* package depends on nx at its own version, so another version nests a second nx and its native addon. Give it the version of nx.',
      notPeer:
        '{{section}} lists {{name}}. Only the workspace root installs nx and @nx/* packages. Move it to peerDependencies, so npm does not nest a second nx and its native addon here.',
    },
  },
  create(context) {
    const folder = dirname(resolve(context.physicalFilename));
    const isRoot = (workspaceRootOf(folder) ?? folder) === folder;
    return {
      'JSONExpressionStatement > JSONObjectExpression'(manifest: Rule.Node) {
        if (!isType(manifest, 'JSONObjectExpression')) return;
        const entries = nxFamilyEntries(manifest);
        if (!isRoot) {
          for (const { section, name, property } of entries) {
            context.report({
              node: property,
              messageId: 'notPeer',
              data: { section, name },
            });
          }
          return;
        }
        const nx = entries.find(({ name }) => name === 'nx')?.version;
        for (const { name, version, versionNode } of entries) {
          const data = { name, version, nx: nx ?? '' };
          if (!EXACT.test(version)) {
            context.report({ node: versionNode, messageId: 'notExact', data });
          } else if (nx !== undefined && version !== nx) {
            context.report({ node: versionNode, messageId: 'notEqual', data });
          }
        }
      },
    };
  },
};

export default rule;
