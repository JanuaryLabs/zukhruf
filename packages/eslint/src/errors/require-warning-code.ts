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

const isStringLike = (type: ts.Type) =>
  unionConstituents(type).every(
    (part) => (part.flags & ts.TypeFlags.StringLike) !== 0,
  );

const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a process warning with no code, and an Error warning passed with options that Node ignores',
    },
    schema: [],
    messages: {
      missingCode:
        "This warning has no code, so a 'warning' listener and `--disable-warning` cannot tell it from a warning of Node or of another package. Give a string warning `{ type, code, detail }`, or emit `Object.assign(new Error(message, { cause }), { name, code, detail })`.",
      optionsIgnored:
        'Node ignores the type, the code and the options of an Error warning, so this call reads as typed and is not. Set `name`, `code` and `detail` on the Error, as `Object.assign(new Error(message, { cause }), { name, code, detail })`, and pass the Error alone.',
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
