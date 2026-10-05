/**
 * Island packages: Nx projects tagged `layer:island`, written as if published
 * to npm. An island depends only on other islands and never on a host's
 * runtime, a port it declares returns `unknown` rather than a generic, and its
 * package.json declares every package its shipped code imports. Library code
 * (every island, plus the `libraries` globs) never reads `process.env` or
 * writes to `console`: the host reads its environment and passes values in.
 *
 * Portable to any Nx workspace: copy this file, put
 * `islandConstraint(hostRuntimes)` in the repo's
 * `@nx/enforce-module-boundaries` depConstraints, and spread
 * `island({ libraries })` into its flat config. Tagging a project is the only
 * step for a new island.
 */
import { posix, relative, sep } from 'node:path';

import { readCachedProjectGraph } from '@nx/devkit';
import nx from '@nx/eslint-plugin';
import * as jsonc from 'jsonc-eslint-parser';
import tseslint from 'typescript-eslint';

export const islandTag = 'layer:island';

export function islandConstraint(hostRuntimes) {
  return {
    sourceTag: islandTag,
    onlyDependOnLibsWithTags: [islandTag],
    bannedExternalImports: hostRuntimes,
  };
}

// Nx's eslint plugin loads this config while it builds the project graph, so
// the graph is read when a rule first runs, never at load, as Nx's own
// enforce-module-boundaries does; read once per ESLint process.
let islandRoots;
function inIsland(filename) {
  islandRoots ??= Object.values(readCachedProjectGraph().nodes)
    .filter((project) => project.data.tags?.includes(islandTag))
    .map((project) => `${project.data.root}/`);
  return islandRoots.some((root) => filename.startsWith(root));
}

const workspacePath = (filename) =>
  relative(import.meta.dirname, filename).replaceAll(sep, '/');

// Runs `rule` only on the files `applies` accepts, so each check follows the
// tag instead of a list of globs.
const scoped = (applies, rule) => ({
  meta: rule.meta,
  create(context) {
    return applies(workspacePath(context.filename), context.settings.island)
      ? rule.create(context)
      : {};
  },
});
const inLibrary = (filename, { libraries }) =>
  inIsland(filename) ||
  libraries.some((glob) => posix.matchesGlob(filename, glob));

// Rules under keys of their own: flat config keeps one options set per rule
// key, so these never replace the repo's own no-restricted-syntax, no-console,
// no-explicit-any or dependency-checks, wherever they are spread. The checks
// are written here rather than borrowed, because ESLint's core rules are not
// public API (docs/src/extend/custom-rules.md: copy, do not extend); a
// plugin's `rules` map is, so typescript-eslint's and Nx's are reused as is.
const check = (message, create) => ({
  meta: { type: 'problem', schema: [], messages: { message } },
  create,
});

const plugin = {
  meta: { name: 'island' },
  rules: {
    // A port the host implements (a requester, a store) returns `unknown` and
    // each consumer narrows it where it reads it. A generic response forces
    // every test stub to assert into T or to return `any`.
    'no-generic-port': scoped(
      inIsland,
      check(
        'A port must not be generic in its response. Return unknown and narrow at the call site.',
        (context) => ({
          ':matches(TSInterfaceDeclaration, TSTypeAliasDeclaration) :matches(TSMethodSignature, TSFunctionType, TSCallSignatureDeclaration)[typeParameters]'(
            node,
          ) {
            context.report({ node, messageId: 'message' });
          },
        }),
      ),
    ),
    'no-explicit-any': scoped(
      inIsland,
      tseslint.plugin.rules['no-explicit-any'],
    ),
    // Every package an island's shipped code imports is declared in its own
    // package.json.
    'dependency-checks': scoped(inIsland, nx.rules['dependency-checks']),
    'no-process-env': scoped(
      inLibrary,
      check(
        'Library code must not read process.env. Take the value as an option the library types; the host reads its environment.',
        (context) => {
          const report = (node) =>
            context.report({ node, messageId: 'message' });
          return {
            "MemberExpression[object.name='process']:matches([computed=false][property.name='env'], [computed=true][property.value='env'])":
              report,
            "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name='env']":
              report,
          };
        },
      ),
    ),
    // `console` output never reaches the host's log or its user; a library
    // reports through the errors it throws and the values it returns. Resolved
    // through scope, as core no-console does, so a local named `console` passes.
    'no-console': scoped(
      inLibrary,
      check(
        'Library code must not write to console. Throw an error or return the value.',
        (context) => ({
          'Program:exit'(node) {
            const scope = context.sourceCode.getScope(node);
            const declared = scope.set.get('console');
            if (declared?.defs.length) return;
            const references =
              declared?.references ??
              scope.through.filter(
                ({ identifier }) => identifier.name === 'console',
              );
            for (const { identifier } of references) {
              if (
                identifier.parent.type === 'MemberExpression' &&
                identifier.parent.object === identifier
              )
                context.report({
                  node: identifier.parent,
                  messageId: 'message',
                });
            }
          },
        }),
      ),
    ),
  },
};

const tests = '**/*.{test,spec}.{ts,tsx,mts,cts}';

// An island declares only its direct imports; consumers resolve the rest.
// Obsolete dependencies are not checked: the check sees static imports only,
// so it would flag a package loaded through a dynamic import(), a CSS
// `@source` or a CLI. Test and build-tool files never ship, so their imports
// are not dependencies.
const dependencyPolicy = {
  includeTransitiveDependencies: false,
  checkMissingDependencies: true,
  checkObsoleteDependencies: false,
  checkVersionMismatches: true,
  ignoredFiles: [
    `{projectRoot}/${tests}`,
    '{projectRoot}/**/{tests,test,e2e,__tests__,__mocks__}/**',
    '{projectRoot}/**/test-setup.{ts,tsx,mts,cts}',
    '{projectRoot}/*.config.{js,cjs,mjs,ts,mts,cts}',
  ],
};

// `libraries`: workspace-relative globs whose code, like every island's, may
// not read process.env or write to console.
export default function island({ libraries }) {
  const plugins = { island: plugin };
  return [
    {
      files: ['**/*.{ts,tsx,mts,cts}'],
      ignores: [tests],
      plugins,
      rules: {
        'island/no-generic-port': 'error',
        'island/no-explicit-any': 'error',
      },
    },
    {
      files: ['**/*.{ts,tsx,mts,cts}'],
      // A script's stdout is its interface, and a config file runs at build
      // time on the developer's environment.
      ignores: [tests, '**/scripts/**', '**/*.config.{js,cjs,mjs,ts,mts,cts}'],
      plugins,
      settings: { island: { libraries } },
      rules: {
        'island/no-process-env': 'error',
        'island/no-console': 'error',
      },
    },
    {
      files: ['**/package.json'],
      languageOptions: { parser: jsonc },
      plugins,
      rules: { 'island/dependency-checks': ['error', dependencyPolicy] },
    },
  ];
}
