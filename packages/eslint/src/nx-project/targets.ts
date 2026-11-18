import { basename } from 'node:path';

import { type AstNode, isType } from '../authoring/ast.ts';
import { objectProperties } from '../authoring/json-ast.ts';

/** A target of a project configuration: its name and its object. */
export interface Target {
  readonly name: string;
  readonly target: AstNode;
}

/**
 * The project configuration in `manifest`: the whole `project.json`, or the
 * `nx` key of a `package.json`. Nx reads both like `JSON.parse`, so the last
 * of two properties with the same key wins.
 */
function projectConfiguration(
  manifest: AstNode,
  filename: string,
): AstNode | undefined {
  if (basename(filename) !== 'package.json') return manifest;
  const nx = new Map(objectProperties(manifest)).get('nx')?.['value'];
  return isType(nx, 'JSONObjectExpression') ? nx : undefined;
}

/** The targets that the project configuration of `manifest` declares. */
export function projectTargets(manifest: AstNode, filename: string): Target[] {
  const configuration = projectConfiguration(manifest, filename);
  const targets = new Map(objectProperties(configuration)).get('targets');
  return objectProperties(targets?.['value']).flatMap(([name, property]) => {
    const target = property['value'];
    return isType(target, 'JSONObjectExpression') ? [{ name, target }] : [];
  });
}
