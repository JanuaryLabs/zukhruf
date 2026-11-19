import type { Rule } from 'eslint';

import { isType } from '../authoring/ast.ts';
import { objectProperties } from '../authoring/json-ast.ts';

/**
 * `vitest/globals` declares describe, it, expect and vi as globals, so the
 * type check accepts a test file that uses them with no import. Without it,
 * the type check rejects a `describe` that the file does not import.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow 'vitest/globals' in compilerOptions.types: each test file imports describe, it and expect from vitest",
    },
    schema: [],
    messages: {
      globalsTypes:
        "'vitest/globals' declares describe, it, expect and vi as globals, so the type check accepts a test that uses them with no import. Remove it, import them from 'vitest' in each test file, and delete test.globals: true from the Vite or Vitest config.",
    },
  },
  create(context) {
    return {
      'JSONExpressionStatement > JSONObjectExpression'(tsconfig: Rule.Node) {
        const compilerOptions = new Map(objectProperties(tsconfig)).get(
          'compilerOptions',
        )?.['value'];
        const types = new Map(objectProperties(compilerOptions)).get('types')?.[
          'value'
        ];
        if (!isType(types, 'JSONArrayExpression')) return;
        const elements: unknown = types['elements'];
        if (!Array.isArray(elements)) return;
        for (const element of elements) {
          if (
            isType(element, 'JSONLiteral') &&
            element['value'] === 'vitest/globals'
          ) {
            context.report({ node: element, messageId: 'globalsTypes' });
          }
        }
      },
    };
  },
};

export default rule;
