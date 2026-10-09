import nx from '@nx/eslint-plugin';
import type { Rule } from 'eslint';

import { ruleOf } from '../authoring/rule-module.ts';
import { inIsland } from '../island/island-scope.ts';
import { isRecord, stringsAt } from '../unknown-values.ts';
import {
  cachedProjectGraph,
  projectNodeAt,
} from '../workspace/cached-project-graph.ts';
import { projectOf } from '../workspace/project-manifest.ts';
import {
  type ManifestPolicyOptions,
  type ProjectExtras,
  manifestPolicy,
} from './manifest-policy.ts';

const nxDependencyChecks = ruleOf(nx, 'dependency-checks');

const strings = { type: 'array', items: { type: 'string' } } as const;

const FLAGS = [
  'checkMissingDependencies',
  'checkObsoleteDependencies',
  'checkVersionMismatches',
] as const;

function projectsOf(value: unknown): Record<string, ProjectExtras> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([folder, extras]) => [
      folder,
      { ignoredDependencies: stringsAt(extras, 'ignoredDependencies') },
    ]),
  );
}

/**
 * The repo's options, as the schema let them through. A flag the repo left
 * out stays out: an `undefined` would let Nx's own default (obsolete checks
 * on) replace the policy's.
 */
function optionsOf(value: unknown): ManifestPolicyOptions {
  if (!isRecord(value)) return {};
  const options: ManifestPolicyOptions = {
    ignoredDependencies: stringsAt(value, 'ignoredDependencies'),
    ignoredFiles: stringsAt(value, 'ignoredFiles'),
    projects: projectsOf(value['projects']),
  };
  if ('buildTargets' in value) {
    options.buildTargets = stringsAt(value, 'buildTargets');
  }
  for (const flag of FLAGS) {
    const set = value[flag];
    if (typeof set === 'boolean') options[flag] = set;
  }
  return options;
}

/**
 * Nx's `dependency-checks`, with the options each manifest's project needs.
 * Flat config gives a rule one set of options per file pattern, and a pattern
 * cannot tell a bundled app from an unbundled one, so the rule decides per linted
 * manifest. Islands are left to `island/dependency-checks`, so a finding is
 * never reported twice.
 */
const rule: Rule.RuleModule = {
  meta: {
    ...nxDependencyChecks.meta,
    docs: {
      description:
        "Check that a package.json declares the packages its project needs, as the project's shape demands",
    },
    schema: [
      {
        type: 'object',
        properties: {
          ignoredDependencies: strings,
          ignoredFiles: strings,
          buildTargets: strings,
          ...Object.fromEntries(
            FLAGS.map((flag) => [flag, { type: 'boolean' }]),
          ),
          projects: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: { ignoredDependencies: strings },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const project = projectOf(context.physicalFilename);
    if (!project || inIsland(context)) return {};
    // Nx's rule checks nothing without the graph or a project in it.
    const graph = cachedProjectGraph();
    const node = graph && projectNodeAt(graph, project.root);
    if (!graph || !node) return {};
    const options = manifestPolicy(graph, node, optionsOf(context.options[0]));
    const projectContext: Rule.RuleContext = Object.create(context, {
      options: { value: [options] },
    });
    return nxDependencyChecks.create(projectContext);
  },
};

export default rule;
