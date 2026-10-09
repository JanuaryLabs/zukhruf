import type { Rule } from 'eslint';

import { isType } from '../authoring/ast.ts';
import { isRecord } from '../unknown-values.ts';

/**
 * `console` output never reaches the host's log or its user; a library
 * reports through the errors it throws and the values it returns. Resolved
 * through scope, as core no-console does, so a local named `console` passes.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow writing to console in library code' },
    schema: [],
    messages: {
      console:
        'Library code must not write to console. Throw an error or return the value.',
    },
  },
  create(context) {
    return {
      'Program:exit'(program) {
        const scope = context.sourceCode.getScope(program);
        const declared = scope.set.get('console');
        if (declared?.defs.length) return;
        const references =
          declared?.references ??
          scope.through.filter(
            ({ identifier }) => identifier.name === 'console',
          );
        for (const { identifier } of references) {
          const parent = isRecord(identifier)
            ? identifier['parent']
            : undefined;
          if (
            isType(parent, 'MemberExpression') &&
            parent['object'] === identifier
          ) {
            context.report({ node: parent, messageId: 'console' });
          }
        }
      },
    };
  },
};

export default rule;
