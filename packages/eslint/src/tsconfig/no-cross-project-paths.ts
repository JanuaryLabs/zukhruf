import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import type { Rule } from 'eslint';

import { isType } from '../authoring/ast.ts';
import { objectProperties } from '../authoring/json-ast.ts';
import { projectOf } from '../workspace/project-manifest.ts';
import { workspaceRootOf } from '../workspace/workspace-root.ts';

function stringValue(node: unknown): string | undefined {
  return isType(node, 'JSONLiteral') && typeof node['value'] === 'string'
    ? node['value']
    : undefined;
}

function arrayElements(node: unknown): unknown[] {
  return isType(node, 'JSONArrayExpression') && Array.isArray(node['elements'])
    ? node['elements']
    : [];
}

/**
 * The folder that a `paths` target points into: the part before its first `*`,
 * resolved from `base`. A part that ends in a file name, as in
 * `./src/index.ts`, points into the file's folder.
 */
function targetFolder(base: string, target: string): string {
  const prefix = target.split('*', 1)[0] ?? '';
  const path = resolve(base, prefix);
  const isFolder =
    prefix === '' ||
    prefix.endsWith('/') ||
    (existsSync(path) && statSync(path).isDirectory());
  return isFolder ? path : dirname(path);
}

/** The root of the project that holds `folder`, as projectOf() finds it. */
function projectRootOf(folder: string): string | undefined {
  return projectOf(join(folder, 'file'))?.root;
}

/**
 * Projects import each other by package name, and `nx sync` writes the
 * project references. A `paths` alias to another project reads its source past
 * its `exports` and its manifest, so the import works in the workspace and
 * breaks where the package is installed.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a compilerOptions.paths alias whose target is in a different project from the tsconfig: projects import each other by package name',
    },
    schema: [],
    messages: {
      crossProject:
        'The alias "{{alias}}" points at "{{target}}", in the project {{project}}. Projects import each other by package name, and `nx sync` writes the project references. Depend on the package and import it by its name.',
    },
  },
  create(context) {
    const folder = dirname(resolve(context.physicalFilename));
    const ownProject = projectRootOf(folder);
    const workspace = workspaceRootOf(folder) ?? folder;
    return {
      'JSONExpressionStatement > JSONObjectExpression'(tsconfig: Rule.Node) {
        if (!isType(tsconfig, 'JSONObjectExpression')) return;
        const compilerOptions = new Map(
          objectProperties(
            new Map(objectProperties(tsconfig)).get('compilerOptions')?.[
              'value'
            ],
          ),
        );
        const baseUrl = stringValue(compilerOptions.get('baseUrl')?.['value']);
        const base = resolve(folder, baseUrl ?? '.');
        const paths = compilerOptions.get('paths')?.['value'];
        for (const [alias, property] of objectProperties(paths)) {
          for (const element of arrayElements(property['value'])) {
            if (!isType(element, 'JSONLiteral')) continue;
            const target = stringValue(element);
            if (target === undefined) continue;
            if (target.split(/[\\/]/).includes('node_modules')) continue;
            const project = projectRootOf(targetFolder(base, target));
            if (project === undefined || project === ownProject) continue;
            context.report({
              node: element,
              messageId: 'crossProject',
              data: {
                alias,
                target,
                project:
                  relative(workspace, project).split(sep).join('/') || '.',
              },
            });
          }
        }
      },
    };
  },
};

export default rule;
