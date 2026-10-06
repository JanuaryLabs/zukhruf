import { ESLintUtils, type TSESTree } from '@typescript-eslint/utils';
import {
  isThenableType,
  isTypeReference,
  unionConstituents,
} from 'ts-api-utils';
import type ts from 'typescript';

import { eslintRule } from '../authoring/rule-module.ts';

/**
 * Whether `type` is a promise, or carries one as a type argument
 * (`Map<string, Promise<X>>`, `Promise<X>[]`). A function type is not entered:
 * a field that holds `() => Promise<X>` holds the memoized function this rule
 * asks for.
 */
function holdsPromise(
  checker: ts.TypeChecker,
  node: ts.Node,
  type: ts.Type,
  seen = new Set<ts.Type>(),
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (isThenableType(checker, node, type)) return true;
  return unionConstituents(type).some(
    (part) =>
      isTypeReference(part) &&
      checker
        .getTypeArguments(part)
        .some((argument) => holdsPromise(checker, node, argument, seen)),
  );
}

/** The node that names a field: its key, or a parameter property's binding. */
function fieldName(
  node:
    | TSESTree.PropertyDefinition
    | TSESTree.AccessorProperty
    | TSESTree.TSAbstractPropertyDefinition
    | TSESTree.TSAbstractAccessorProperty
    | TSESTree.TSParameterProperty,
): TSESTree.Node {
  if (node.type !== 'TSParameterProperty') return node.key;
  return node.parameter.type === 'AssignmentPattern'
    ? node.parameter.left
    : node.parameter;
}

const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow class fields that hold a promise, which caches its rejection and races when reset',
    },
    schema: [],
    messages: {
      promiseField:
        'Do not keep a promise in a field: it caches a rejection, can reject before anyone awaits it, and races when it is reset. Memoize the async function (p-memoize), model the phase as a State object, or wait on a one-shot latch.',
    },
  },
  defaultOptions: [],
  create(context) {
    // Throws the standard "requires type information" error without typed lint.
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const check = (node: Parameters<typeof fieldName>[0]) => {
      const name = fieldName(node);
      const type = services.getTypeAtLocation(name);
      const tsNode = services.esTreeNodeToTSNodeMap.get(name);
      if (holdsPromise(checker, tsNode, type)) {
        context.report({ node, messageId: 'promiseField' });
      }
    };
    return {
      PropertyDefinition: check,
      AccessorProperty: check,
      TSAbstractPropertyDefinition: check,
      TSAbstractAccessorProperty: check,
      TSParameterProperty: check,
    };
  },
});

export default eslintRule(rule);
