import { ESLintUtils, type TSESTree } from '@typescript-eslint/utils';

import { eslintRule } from '../authoring/rule-module.ts';

type Signature =
  | TSESTree.TSMethodSignature
  | TSESTree.TSFunctionType
  | TSESTree.TSCallSignatureDeclaration;

const isSignature = (node: TSESTree.Node): node is Signature =>
  node.type === 'TSMethodSignature' ||
  node.type === 'TSFunctionType' ||
  node.type === 'TSCallSignatureDeclaration';

/**
 * A port the host implements (a requester, a store) returns `unknown`, and
 * each consumer narrows it where it reads it. A generic response forces every
 * test stub to assert into T or to return `any`. A type parameter that only
 * the inputs use, such as the rows of a callback, is not a response.
 */
const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow ports (interfaces and function types) whose methods are generic in their response',
    },
    schema: [],
    messages: {
      matched:
        'A port must not be generic in its response. Return unknown and narrow at the call site.',
    },
  },
  create(context) {
    const reported = new Set<Signature>();
    return {
      ':matches(TSInterfaceDeclaration, TSTypeAliasDeclaration) TSTypeReference'(
        reference: TSESTree.TSTypeReference,
      ) {
        if (reference.typeName.type !== 'Identifier') return;
        const { name } = reference.typeName;
        const ancestors = context.sourceCode.getAncestors(reference);
        // The nearest signature that declares the name owns the reference.
        const owner = ancestors.findLast(
          (node): node is Signature =>
            isSignature(node) &&
            node.typeParameters?.params.some(
              (parameter) => parameter.name.name === name,
            ) === true,
        );
        if (
          owner?.returnType &&
          ancestors.includes(owner.returnType) &&
          !reported.has(owner)
        ) {
          reported.add(owner);
          context.report({ node: owner, messageId: 'matched' });
        }
      },
    };
  },
});

export default eslintRule(rule);
