import { ESLintUtils, type TSESTree } from '@typescript-eslint/utils';
import { isTypeFlagSet, unionConstituents } from 'ts-api-utils';
import * as ts from 'typescript';

import { eslintRule } from '../authoring/rule-module.ts';

const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow a string as zod's ctx.addIssue argument, which in zod 4 aborts the checks of every parent schema",
    },
    schema: [],
    messages: {
      stringIssue:
        "Pass an object: `ctx.addIssue({ code: 'custom', message })`. In zod 4 the string form makes an issue without `continue: true`, so the refine and superRefine checks of every parent schema stop running.",
    },
  },
  create(context) {
    // Throws the standard "requires type information" error without typed lint.
    const services = ESLintUtils.getParserServices(context);
    /** Whether the type of `argument` is a string in each of its union members. */
    const isString = (argument: TSESTree.Node) =>
      unionConstituents(services.getTypeAtLocation(argument)).every((type) =>
        isTypeFlagSet(type, ts.TypeFlags.StringLike),
      );
    return {
      'CallExpression[callee.type="MemberExpression"][callee.property.name="addIssue"][arguments.length=1]'(
        node: TSESTree.CallExpression,
      ) {
        const [argument] = node.arguments;
        if (argument !== undefined && isString(argument)) {
          context.report({ node, messageId: 'stringIssue' });
        }
      },
    };
  },
});

export default eslintRule(rule);
