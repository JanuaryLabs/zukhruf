import { ESLintUtils, type TSESTree } from '@typescript-eslint/utils';
import { unionConstituents } from 'ts-api-utils';
import * as ts from 'typescript';

import { eslintRule } from '../authoring/rule-module.ts';

/**
 * `emitWarning` as @types/node declares it: a method of the interface
 * `Process`. A call through `process`, `globalThis.process`, the default
 * export of `node:process` or its named export `emitWarning` resolves to it.
 */
function isEmitWarning(declaration: ts.Declaration | undefined): boolean {
  return (
    declaration !== undefined &&
    ts.isMethodSignature(declaration) &&
    ts.isIdentifier(declaration.name) &&
    declaration.name.text === 'emitWarning' &&
    ts.isInterfaceDeclaration(declaration.parent) &&
    declaration.parent.name.text === 'Process'
  );
}

/** `Object.assign` as the lib of TypeScript declares it: a method of the interface `ObjectConstructor`. */
function isObjectAssign(declaration: ts.Declaration | undefined): boolean {
  return (
    declaration !== undefined &&
    ts.isMethodSignature(declaration) &&
    ts.isIdentifier(declaration.name) &&
    declaration.name.text === 'assign' &&
    ts.isInterfaceDeclaration(declaration.parent) &&
    declaration.parent.name.text === 'ObjectConstructor'
  );
}

const isStringLike = (type: ts.Type) =>
  unionConstituents(type).every(
    (part) => (part.flags & ts.TypeFlags.StringLike) !== 0,
  );

const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a process warning with no code, an Error warning passed with options that Node ignores, and an Error warning built in place with Object.assign',
    },
    schema: [],
    messages: {
      missingCode:
        "This warning has no code, so a 'warning' listener and `--disable-warning` cannot tell it from a warning of Node or of another package. Emit an instance of a warning class that sets its `name`, `code` and `detail`, as `process.emitWarning(new LeaderSelectorWarning(failure, { election }))`, or give a string warning `{ type, code, detail }`.",
      optionsIgnored:
        'Node ignores the type, the code and the options of an Error warning, so this call reads as typed and is not. Set `name`, `code` and `detail` in a warning class, and pass its instance alone, as `process.emitWarning(new LeaderSelectorWarning(failure, { election }))`.',
      inlineWarning:
        'This warning is an Error with `name`, `code` and `detail` set in place, so a host cannot test it with `instanceof`. Declare a warning class that `extends Error` and sets its `name`, `code` and `detail`, export it, and emit its instance, as `process.emitWarning(new LeaderSelectorWarning(failure, { election }))`.',
    },
  },
  create(context) {
    // Throws the standard "requires type information" error without typed lint.
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const typeOf = (node: TSESTree.Node) =>
      checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));
    const hasCode = (node: TSESTree.Node) =>
      checker.getPropertyOfType(typeOf(node), 'code') !== undefined;
    const isAssigned = (node: TSESTree.Node) =>
      node.type === 'CallExpression' &&
      isObjectAssign(
        checker.getResolvedSignature(services.esTreeNodeToTSNodeMap.get(node))
          ?.declaration,
      );
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const [warning, second, third] = node.arguments;
        if (warning === undefined) return;
        const call = services.esTreeNodeToTSNodeMap.get(node);
        if (!isEmitWarning(checker.getResolvedSignature(call)?.declaration))
          return;
        if (!isStringLike(typeOf(warning))) {
          if (second !== undefined)
            context.report({ node, messageId: 'optionsIgnored' });
          else if (isAssigned(warning))
            context.report({ node, messageId: 'inlineWarning' });
          else if (!hasCode(warning))
            context.report({ node, messageId: 'missingCode' });
          return;
        }
        // emitWarning(warning, options), or emitWarning(warning, type, code).
        const coded =
          second !== undefined &&
          (isStringLike(typeOf(second))
            ? third !== undefined && isStringLike(typeOf(third))
            : hasCode(second));
        if (!coded) context.report({ node, messageId: 'missingCode' });
      },
    };
  },
});

export default eslintRule(rule);
