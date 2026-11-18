import { type Tree, readJson } from '@nx/devkit';

/**
 * The workspace scope: `acme` for the root package name `@acme/source`. It
 * stops with an error for a name with no scope, so no generator writes the
 * scope of another repo (#4080).
 */
export function workspaceScope(tree: Tree): string {
  const { name } = readJson<{ name?: string }>(tree, 'package.json');
  const scope = /^@([^/]+)\//.exec(name ?? '')?.[1];
  if (scope === undefined) {
    throw new Error(
      `The root package name ${JSON.stringify(name ?? null)} has no scope. Name it "@<scope>/source" in package.json, for example "@acme/source", and run the generator again.`,
    );
  }
  return scope;
}
