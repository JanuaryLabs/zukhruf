import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { Rule } from 'eslint';
import { getStaticJSONValue, parseJSON } from 'jsonc-eslint-parser';

import { type AstNode, isType } from '../authoring/ast.ts';
import { objectProperties } from '../authoring/json-ast.ts';
import { isRecord } from '../unknown-values.ts';
import { workspaceRootOf } from '../workspace/workspace-root.ts';
import { projectTargets } from './targets.ts';

const ESBUILD = '@nx/esbuild:esbuild';

/** The text of the file at `path`; `undefined` when there is none. */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') return undefined;
    throw error;
  }
}

/** The JSON file at `path`, comments allowed as in a tsconfig. */
function readJsonc(path: string): unknown {
  const text = readText(path);
  return text === undefined ? undefined : getStaticJSONValue(parseJSON(text));
}

function usesPackageManagerWorkspaces(root: string): boolean {
  const manifest = readJsonc(join(root, 'package.json'));
  if (isRecord(manifest) && manifest['workspaces']) return true;
  return /^packages\s*:/m.test(
    readText(join(root, 'pnpm-workspace.yaml')) ?? '',
  );
}

function emptyOrUnset(value: unknown): boolean {
  return !Array.isArray(value) || value.length === 0;
}

/**
 * `isUsingTsSolutionSetup()` of `@nx/js` (23.2), which the esbuild executor
 * calls, read from the same root files: package-manager workspaces, a
 * tsconfig.json that extends `./tsconfig.base.json` and sets `files` or
 * `include` only as an empty list, and a tsconfig.base.json with `composite`
 * and `declaration` not `false`. The function sits in `@nx/js/internal`, which
 * this package does not depend on, and it reads `workspaceRoot` from the
 * process, not from the linted file.
 */
function isTsSolutionWorkspace(root: string): boolean {
  if (!usesPackageManagerWorkspaces(root)) return false;
  const solution = readJsonc(join(root, 'tsconfig.json'));
  if (!isRecord(solution) || solution['extends'] !== './tsconfig.base.json') {
    return false;
  }
  if (!solution['files'] && !solution['include']) return false;
  if (!emptyOrUnset(solution['files']) || !emptyOrUnset(solution['include'])) {
    return false;
  }
  const base = readJsonc(join(root, 'tsconfig.base.json'));
  const options = isRecord(base) ? base['compilerOptions'] : undefined;
  return (
    isRecord(options) &&
    Boolean(options['composite']) &&
    options['declaration'] !== false
  );
}

// Rules run once per linted file; the files of a run share one root.
const tsSolutionByRoot = new Map<string, boolean>();

function inTsSolutionWorkspace(filename: string): boolean {
  const root = workspaceRootOf(dirname(resolve(filename)));
  if (root === undefined) return false;
  if (!tsSolutionByRoot.has(root)) {
    tsSolutionByRoot.set(root, isTsSolutionWorkspace(root));
  }
  return tsSolutionByRoot.get(root) === true;
}

/** The option objects of `target`: `options` and each entry of `configurations`. */
function optionObjects(target: AstNode): unknown[] {
  const keys = new Map(objectProperties(target));
  return [
    keys.get('options')?.['value'],
    ...objectProperties(keys.get('configurations')?.['value']).map(
      ([, configuration]) => configuration['value'],
    ),
  ];
}

/**
 * The esbuild executor of Nx throws when `generatePackageJson` is set in a TS
 * solution workspace. There the project's own package.json is the deploy
 * manifest, and `prune-lockfile` writes it with the lockfile into the output.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow generatePackageJson in an @nx/esbuild target of a TS solution workspace: the executor throws',
    },
    schema: [],
    messages: {
      generatePackageJson:
        'Target "{{target}}" sets generatePackageJson, and this is a TS solution workspace: @nx/esbuild:esbuild throws on it. Remove the option. The project\'s package.json is its deploy manifest; run the prune-lockfile target to write it and the lockfile into the output.',
    },
  },
  create(context) {
    if (!inTsSolutionWorkspace(context.physicalFilename)) return {};
    return {
      'JSONExpressionStatement > JSONObjectExpression'(manifest: Rule.Node) {
        if (!isType(manifest, 'JSONObjectExpression')) return;
        for (const { name, target } of projectTargets(
          manifest,
          context.physicalFilename,
        )) {
          const executor = new Map(objectProperties(target)).get('executor')?.[
            'value'
          ];
          if (
            !isType(executor, 'JSONLiteral') ||
            executor['value'] !== ESBUILD
          ) {
            continue;
          }
          for (const options of optionObjects(target)) {
            const option = new Map(objectProperties(options)).get(
              'generatePackageJson',
            );
            if (option === undefined) continue;
            const setting = option['value'];
            if (!isType(setting, 'JSONLiteral') || !setting['value']) continue;
            context.report({
              node: option,
              messageId: 'generatePackageJson',
              data: { target: name },
            });
          }
        }
      },
    };
  },
};

export default rule;
