import type { Rule } from 'eslint';

import { isType } from '../authoring/ast.ts';
import { objectProperties } from '../authoring/json-ast.ts';
import { projectTargets } from './targets.ts';

/**
 * The old spellings of `projects` that name no project: `self` is the target's
 * own project and `dependencies` is `^`. Nx still reads them, with a warning.
 */
const LEGACY = new Set(['self', 'dependencies']);

/**
 * Build order comes from the import graph: `^build` builds each project that
 * the project imports, first. A `dependsOn` entry with `projects` is an order
 * written by hand, and it stays after the import is gone. The string form
 * `"<project>:<target>"` is not reported: a target name can hold a colon,
 * such as `format:check`, and only the project graph tells the two apart.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a dependsOn entry that names projects: build order comes from the import graph, through ^<target>',
    },
    schema: [],
    messages: {
      namedProject:
        'Target "{{target}}" depends on named projects. Build order comes from the import graph: write "^<target>" to run the target of each project this one imports, or import the project.',
    },
  },
  create(context) {
    return {
      'JSONExpressionStatement > JSONObjectExpression'(manifest: Rule.Node) {
        if (!isType(manifest, 'JSONObjectExpression')) return;
        for (const { name, target } of projectTargets(
          manifest,
          context.physicalFilename,
        )) {
          const dependsOn = new Map(objectProperties(target)).get('dependsOn');
          const entries = dependsOn?.['value'];
          if (!isType(entries, 'JSONArrayExpression')) continue;
          const elements: unknown[] = Array.isArray(entries['elements'])
            ? entries['elements']
            : [];
          for (const entry of elements) {
            const projects = new Map(objectProperties(entry)).get('projects');
            if (projects === undefined) continue;
            const value = projects['value'];
            const namesNone =
              (isType(value, 'JSONLiteral') &&
                typeof value['value'] === 'string' &&
                LEGACY.has(value['value'])) ||
              (isType(value, 'JSONArrayExpression') &&
                Array.isArray(value['elements']) &&
                value['elements'].length === 0);
            if (namesNone) continue;
            context.report({
              node: projects,
              messageId: 'namedProject',
              data: { target: name },
            });
          }
        }
      },
    };
  },
};

export default rule;
