import type { Rule, Scope } from 'eslint';

import { isRecord } from '../unknown-values.ts';

/** An AST node whose fields are read one by one, each narrowed where it is read. */
export type AstNode = Rule.Node & Record<string, unknown>;

export function isAstNode(value: unknown): value is AstNode {
  return isRecord(value) && typeof value['type'] === 'string';
}

export function isType(value: unknown, type: string): value is AstNode {
  return isAstNode(value) && value['type'] === type;
}

export function identifierName(value: unknown): string | undefined {
  return isType(value, 'Identifier') && typeof value['name'] === 'string'
    ? value['name']
    : undefined;
}

/** The variable that `identifier` reads or writes, when this file declares it. */
export function resolvedVariable(
  context: Rule.RuleContext,
  identifier: AstNode,
): Scope.Variable | undefined {
  return (
    context.sourceCode
      .getScope(identifier)
      .references.find((reference) => reference.identifier === identifier)
      ?.resolved ?? undefined
  );
}
