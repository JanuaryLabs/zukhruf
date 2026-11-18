import { dirname, resolve } from 'node:path';

import type { Rule } from 'eslint';

import { isType } from '../authoring/ast.ts';
import { objectProperties } from '../authoring/json-ast.ts';
import { workspaceRootOf } from '../workspace/workspace-root.ts';

/** npm runs `prepare` after `npm install`, and it installs the Git hooks. */
const ALLOWED = new Set(['prepare']);

/**
 * Each command of the workspace runs as an Nx target, so Nx knows its inputs,
 * caches it and orders it. The root package.json keeps only `prepare`. A
 * package.json outside any workspace has no Nx targets to move to, so the rule
 * checks only the manifest in the workspace root's own folder.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow npm scripts other than prepare in the workspace root package.json: each command runs as an Nx target',
    },
    schema: [],
    messages: {
      rootScript:
        'The workspace root has the npm script "{{script}}". Each command runs as an Nx target, so Nx knows its inputs, caches it and orders it. Move it to a target of the project it belongs to; the root keeps only "prepare".',
    },
  },
  create(context) {
    const folder = dirname(resolve(context.physicalFilename));
    if (workspaceRootOf(folder) !== folder) return {};
    return {
      'JSONExpressionStatement > JSONObjectExpression'(manifest: Rule.Node) {
        if (!isType(manifest, 'JSONObjectExpression')) return;
        const scripts = new Map(objectProperties(manifest)).get('scripts');
        for (const [script, property] of objectProperties(scripts?.['value'])) {
          if (ALLOWED.has(script)) continue;
          context.report({
            node: property,
            messageId: 'rootScript',
            data: { script },
          });
        }
      },
    };
  },
};

export default rule;
