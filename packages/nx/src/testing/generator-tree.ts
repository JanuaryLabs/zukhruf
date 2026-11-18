import { type Tree, readJson, writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

/**
 * The virtual Tree of a new workspace for an app generator test: the root
 * package `name`, no formatter config and no root files of the standard. The
 * app generators run `init`, which writes them.
 */
export function generatorTree(name = '@acme/source'): Tree {
  const tree = createTreeWithEmptyWorkspace({ formatter: 'none' });
  tree.delete('tsconfig.base.json');
  writeJson(tree, 'package.json', {
    name,
    dependencies: {},
    devDependencies: {},
  });
  return tree;
}

/** The names of each root dependency and devDependency. */
export function rootPackageNames(tree: Tree): string[] {
  const { dependencies, devDependencies } = readJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(tree, 'package.json');
  return [
    ...Object.keys(dependencies ?? {}),
    ...Object.keys(devDependencies ?? {}),
  ];
}

/** Each change of the Tree, by path, with its content. */
export function changes(tree: Tree): Map<string, string | undefined> {
  return new Map(
    tree
      .listChanges()
      .map((change) => [change.path, change.content?.toString()]),
  );
}
