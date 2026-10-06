import type { Rule } from 'eslint';

/** An AST node whose fields are read one by one, each narrowed where it is read. */
export type AstNode = Rule.Node & Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The string entries of `value[key]`: options and manifests arrive as `unknown`. */
export function stringsAt(value: unknown, key: string): string[] {
  const list = isRecord(value) ? value[key] : undefined;
  return Array.isArray(list)
    ? list.filter((item): item is string => typeof item === 'string')
    : [];
}

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
