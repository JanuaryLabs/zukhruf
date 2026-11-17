import { type AstNode, isType } from './ast.ts';

/**
 * The name of the key of a JSON property. JSON reads only a quoted key, and so
 * do `JSON.parse` and Nx's `parseJson`, which reject an identifier key.
 */
export function propertyKey(property: AstNode): string | undefined {
  const key = property['key'];
  return isType(key, 'JSONLiteral') && typeof key['value'] === 'string'
    ? key['value']
    : undefined;
}

/**
 * The properties of a JSON object, each with the name of its key, as
 * `JSON.parse` reads them: when two properties have the same key, the last one
 * wins and the earlier one is not included.
 */
export function objectProperties(object: unknown): [string, AstNode][] {
  if (!isType(object, 'JSONObjectExpression')) return [];
  const entries = object['properties'];
  if (!Array.isArray(entries)) return [];
  const properties = new Map<string, AstNode>();
  for (const property of entries) {
    if (!isType(property, 'JSONProperty')) continue;
    const key = propertyKey(property);
    if (key !== undefined) properties.set(key, property);
  }
  return [...properties];
}
