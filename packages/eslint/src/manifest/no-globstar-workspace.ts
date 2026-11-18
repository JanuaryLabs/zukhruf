import type { Rule } from 'eslint';

import { isType } from '../authoring/ast.ts';
import { objectProperties } from '../authoring/json-ast.ts';

/**
 * npm matches each `workspaces` glob without `dot`, and a `**` reaches every
 * folder below it: an untracked folder with a package.json, or the
 * dist/package.json that a build writes, becomes a workspace. The root lists
 * each project folder with a single `*` (`apps/*`, `packages/*`) and names a
 * dot folder by its path. A negated glob takes folders out, so it can hold `**`.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow ** in a workspaces glob of package.json: it makes a workspace of each untracked folder and each dist/package.json below it',
    },
    schema: [],
    messages: {
      globstar:
        'The workspaces glob "{{glob}}" has **. It makes a workspace of each folder below it that holds a package.json, also an untracked folder and the dist/package.json of a build. List each project folder with a single * (apps/*, packages/*), and name a dot folder by its path: npm matches workspaces without dot.',
    },
  },
  create(context) {
    return {
      'JSONExpressionStatement > JSONObjectExpression'(manifest: Rule.Node) {
        if (!isType(manifest, 'JSONObjectExpression')) return;
        const workspaces = new Map(objectProperties(manifest)).get(
          'workspaces',
        )?.['value'];
        if (!isType(workspaces, 'JSONArrayExpression')) return;
        const elements = workspaces['elements'];
        if (!Array.isArray(elements)) return;
        for (const element of elements) {
          if (!isType(element, 'JSONLiteral')) continue;
          const glob = element['value'];
          if (typeof glob !== 'string' || glob.startsWith('!')) continue;
          if (!glob.split('/').includes('**')) continue;
          context.report({
            node: element,
            messageId: 'globstar',
            data: { glob },
          });
        }
      },
    };
  },
};

export default rule;
