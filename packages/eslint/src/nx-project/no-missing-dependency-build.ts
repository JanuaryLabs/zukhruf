import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, matchesGlob, relative, resolve, sep } from 'node:path';

import type {
  ProjectGraph,
  ProjectGraphProjectNode,
  TargetConfiguration,
} from '@nx/devkit';
import type { Rule } from 'eslint';

import { type AstNode, isAstNode, isType } from '../authoring/ast.ts';
import { objectProperties } from '../authoring/json-ast.ts';
import { isRecord } from '../unknown-values.ts';
import { readJson } from '../workspace/project-manifest.ts';
import { type Script, scriptsRun } from './command-scripts.ts';
import { packageEntry, splitSpecifier } from './package-entry.ts';
import { loadedSpecifiers, relativeModule } from './static-imports.ts';
import { taskClosure } from './task-closure.ts';

type Devkit = typeof import('@nx/devkit');

interface WorkspacePackage {
  readonly node: ProjectGraphProjectNode;
  readonly directory: string;
  readonly manifest: Record<string, unknown>;
}

/** A workspace package that a script loads from the output of its build. */
interface BuiltImport {
  readonly script: string;
  readonly specifier: string;
  readonly entry: string;
  readonly project: string;
}

const RUNS_SOURCE = /\.(?:[cm]?ts|[cm]?js)$/;

// @nx/devkit is an optional peer of this entry, which non-Nx repos load too,
// so it is required only when a project.json is linted.
function loadDevkit(): Devkit | undefined {
  try {
    return createRequire(import.meta.url)('@nx/devkit');
  } catch (error) {
    if (isRecord(error) && error['code'] === 'MODULE_NOT_FOUND') {
      return undefined;
    }
    throw error;
  }
}

// There is no cached graph before Nx builds one, as on a fresh clone; Nx's
// own lint rules then skip their checks, and so does this one.
function readCachedGraph(devkit: Devkit): ProjectGraph | undefined {
  try {
    return devkit.readCachedProjectGraph();
  } catch {
    return undefined;
  }
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function interpolate(text: string, node: ProjectGraphProjectNode): string {
  return text
    .replaceAll('{projectRoot}', node.data.root)
    .replaceAll('{workspaceRoot}', '.');
}

/** Each command line of a target with the folder it runs in. */
function commandLines(
  target: TargetConfiguration,
  node: ProjectGraphProjectNode,
  root: string,
): Array<{ line: string; cwd: string }> {
  const options: unknown = target.options;
  if (!isRecord(options)) return [];
  if (target.executor === 'nx:run-commands') {
    const cwd =
      typeof options['cwd'] === 'string'
        ? resolve(root, interpolate(options['cwd'], node))
        : root;
    const commands = [
      options['command'],
      ...(Array.isArray(options['commands']) ? options['commands'] : []),
    ];
    return commands.flatMap((command: unknown) => {
      const line = isRecord(command) ? command['command'] : command;
      return typeof line === 'string'
        ? [{ line: interpolate(line, node), cwd }]
        : [];
    });
  }
  if (target.executor === 'nx:run-script') {
    const directory = join(root, node.data.root);
    const manifest = readJson(join(directory, 'package.json'));
    const scripts = isRecord(manifest) ? manifest['scripts'] : undefined;
    const script = isRecord(scripts) ? scripts[String(options['script'])] : '';
    return typeof script === 'string' ? [{ line: script, cwd: directory }] : [];
  }
  return [];
}

function workspacePackages(
  graph: ProjectGraph,
  root: string,
): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  for (const node of Object.values(graph.nodes)) {
    const directory = join(root, node.data.root);
    const manifest = readJson(join(directory, 'package.json'));
    if (isRecord(manifest) && typeof manifest['name'] === 'string') {
      packages.set(manifest['name'], { node, directory, manifest });
    }
  }
  return packages;
}

class BuiltImportFinder {
  readonly #devkit: Devkit;
  readonly #root: string;
  readonly #packages: Map<string, WorkspacePackage>;

  constructor(devkit: Devkit, root: string, graph: ProjectGraph) {
    this.#devkit = devkit;
    this.#root = root;
    this.#packages = workspacePackages(graph, root);
  }

  /**
   * The workspace packages that `script` loads, through relative imports and
   * the source of packages that resolve to source, whose entry lies in the
   * outputs of their build target.
   */
  find({ file, conditions }: Script): BuiltImport[] {
    const found: BuiltImport[] = [];
    const seen = new Set<string>();
    const queue = [file];
    for (let current = queue.pop(); current; current = queue.pop()) {
      if (seen.has(current)) continue;
      seen.add(current);
      for (const specifier of loadedSpecifiers(current)) {
        if (specifier.startsWith('.')) {
          const module = relativeModule(current, specifier);
          if (module) queue.push(module);
          continue;
        }
        const { name, subpath } = splitSpecifier(specifier);
        const pkg = this.#packages.get(name);
        const target = pkg && packageEntry(pkg.manifest, subpath, conditions);
        if (!pkg || target === undefined) continue;
        const entry = resolve(pkg.directory, target);
        if (this.#isBuildOutput(pkg.node, entry)) {
          found.push({
            script: file,
            specifier,
            entry,
            project: pkg.node.name,
          });
        } else if (RUNS_SOURCE.test(entry) && existsSync(entry)) {
          queue.push(entry);
        }
      }
    }
    return found;
  }

  #isBuildOutput(node: ProjectGraphProjectNode, entry: string): boolean {
    if (!node.data.targets?.['build']) return false;
    const path = toPosix(relative(this.#root, entry));
    return this.#devkit
      .getOutputsForTargetAndConfiguration(
        { project: node.name, target: 'build' },
        {},
        node,
      )
      .filter((output) => !output.startsWith('!'))
      .some(
        (output) =>
          path === output ||
          path.startsWith(`${output}/`) ||
          matchesGlob(path, output),
      );
  }
}

function rootObject(program: unknown): AstNode | undefined {
  if (!isAstNode(program)) return undefined;
  const [statement] = Array.isArray(program['body']) ? program['body'] : [];
  return isType(statement, 'JSONExpressionStatement') &&
    isType(statement['expression'], 'JSONObjectExpression')
    ? statement['expression']
    : undefined;
}

function propertyNamed(object: unknown, key: string): AstNode | undefined {
  return new Map(objectProperties(object)).get(key);
}

function keyOf(property: AstNode | undefined): AstNode | undefined {
  const key = property?.['key'];
  return isAstNode(key) ? key : undefined;
}

function addDependencyBuild(
  target: AstNode,
): ((fixer: Rule.RuleFixer) => Rule.Fix) | undefined {
  const value = target['value'];
  if (!isType(value, 'JSONObjectExpression')) return undefined;
  const dependsOn = propertyNamed(value, 'dependsOn')?.['value'];
  if (dependsOn !== undefined) {
    if (!isType(dependsOn, 'JSONArrayExpression')) return undefined;
    const [first] = Array.isArray(dependsOn['elements'])
      ? dependsOn['elements']
      : [];
    return isAstNode(first)
      ? (fixer) => fixer.insertTextBefore(first, '"^build", ')
      : (fixer) => fixer.replaceText(dependsOn, '["^build"]');
  }
  const [first] = Array.isArray(value['properties']) ? value['properties'] : [];
  return isType(first, 'JSONProperty')
    ? (fixer) => fixer.insertTextBefore(first, '"dependsOn": ["^build"], ')
    : (fixer) => fixer.replaceText(value, '{ "dependsOn": ["^build"] }');
}

/**
 * A target that runs a file with Node, where the file imports a workspace
 * package that Node loads from the output of that package's build, must run
 * after that build. Locally a stale `dist` hides the gap; a clean checkout
 * fails with ERR_MODULE_NOT_FOUND.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    hasSuggestions: true,
    docs: {
      description:
        "Require a target that runs a file importing a built workspace package to depend on that package's build",
    },
    messages: {
      missingDependencyBuild:
        'Target "{{target}}" runs {{file}}, which imports {{package}}. Node loads {{entry}}, which {{project}}:build writes. Add "^build" to dependsOn, or a clean checkout fails with ERR_MODULE_NOT_FOUND.',
      addDependencyBuild: 'Add "^build" to dependsOn.',
    },
    schema: [],
  },
  create(context) {
    const projectRoot = dirname(context.physicalFilename);
    return {
      Program() {
        const devkit = loadDevkit();
        const graph = devkit && readCachedGraph(devkit);
        if (!devkit || !graph) return;
        const root = devkit.workspaceRoot;
        const node = Object.values(graph.nodes).find(
          (candidate) => resolve(root, candidate.data.root) === projectRoot,
        );
        if (!node) return;
        const finder = new BuiltImportFinder(devkit, root, graph);
        const json = rootObject(context.sourceCode.ast);
        const targetsProperty = propertyNamed(json, 'targets');
        for (const [name, target] of Object.entries(node.data.targets ?? {})) {
          const missing = commandLines(target, node, root)
            .flatMap(({ line, cwd }) => scriptsRun(line, cwd))
            .flatMap((script) => finder.find(script));
          if (missing.length === 0) continue;
          const closure = taskClosure(graph, node.name, name);
          const unbuilt = missing.find(
            ({ project }) => !closure.has(`${project}:build`),
          );
          if (!unbuilt) continue;
          const targetProperty = propertyNamed(
            targetsProperty?.['value'],
            name,
          );
          const fix = targetProperty && addDependencyBuild(targetProperty);
          const at = keyOf(targetProperty) ?? keyOf(targetsProperty);
          context.report({
            ...(at ? { node: at } : { loc: { line: 1, column: 0 } }),
            messageId: 'missingDependencyBuild',
            data: {
              target: name,
              file: toPosix(relative(root, unbuilt.script)),
              package: unbuilt.specifier,
              entry: toPosix(relative(root, unbuilt.entry)),
              project: unbuilt.project,
            },
            suggest: fix ? [{ messageId: 'addDependencyBuild', fix }] : [],
          });
        }
      },
    };
  },
};

export default rule;
