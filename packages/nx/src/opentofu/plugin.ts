import { basename, dirname, extname, join, relative } from 'node:path';

import {
  type CreateNodes,
  type TargetConfiguration,
  createNodesFromFiles,
} from '@nx/devkit';

import { nearestRoot, projectRootFiles } from '../project-roots.ts';

const environmentFile = /^src\/environments\/([^/]+)\/[^/]+\.tf$/;

// The freshness check ships beside this file: `.ts` in the source that
// zukhruf runs, `.js` in the build that npm installs.
const checkPlanFresh = join(
  import.meta.dirname,
  `check-plan-fresh${extname(import.meta.filename)}`,
);

// The state and the saved plans are encrypted with `tf_encryption_passphrase`
// in each of the 5 copies; the other secrets differ by project, and OpenTofu
// reports a missing variable itself.
const passphrase =
  ': "${TF_ENCRYPTION_PASSPHRASE:?TF_ENCRYPTION_PASSPHRASE missing: set it in the environment or in the .env file of the project}" && TF_VAR_tf_encryption_passphrase="$TF_ENCRYPTION_PASSPHRASE"';

/**
 * Gives the OpenTofu targets to each project root with environments: folders
 * `src/environments/<name>` with `*.tf` files. The checks need no secret; the
 * targets that read the encrypted state guard the passphrase. No `apply`: CI
 * applies.
 */
export const createNodes: CreateNodes = [
  '{package.json,**/package.json,project.json,**/project.json,**/src/environments/*/*.tf}',
  (files, options, context) => {
    const rootFiles = projectRootFiles(
      files.filter((file) =>
        ['package.json', 'project.json'].includes(basename(file)),
      ),
      context.workspaceRoot,
    );
    const roots = new Set(rootFiles.map((file) => dirname(file)));
    const environments = new Map<string, Set<string>>();
    for (const file of files.filter((file) => file.endsWith('.tf'))) {
      const root = nearestRoot(roots, dirname(file));
      const name =
        root === undefined
          ? undefined
          : environmentFile.exec(relative(root, file))?.[1];
      if (root !== undefined && name !== undefined) {
        environments.set(root, (environments.get(root) ?? new Set()).add(name));
      }
    }
    return createNodesFromFiles(
      (file) => {
        const root = dirname(file);
        const [first, ...rest] = [...(environments.get(root) ?? [])].toSorted();
        return first === undefined
          ? {}
          : {
              projects: {
                [root]: {
                  targets: targets(
                    root,
                    [first, ...rest],
                    context.workspaceRoot,
                  ),
                },
              },
            };
      },
      rootFiles,
      options,
      context,
    );
  },
];

function targets(
  root: string,
  environments: [string, ...string[]],
  workspaceRoot: string,
): Record<string, TargetConfiguration> {
  const inputs = [
    '{projectRoot}/src/**/*.tf',
    '{projectRoot}/src/**/*.hcl',
    { runtime: 'tofu version' },
  ];
  // `-c <name>` selects an environment; with none, the options select
  // production, else the first environment by name.
  const fallback = environments.includes('production')
    ? 'production'
    : environments[0];
  const inEnvironment = (
    command: string,
    dependsOn: string[] = [],
  ): TargetConfiguration => ({
    executor: 'nx:run-commands',
    options: { command, cwd: `{projectRoot}/src/environments/${fallback}` },
    configurations: Object.fromEntries(
      environments.map((name) => [
        name,
        { cwd: `{projectRoot}/src/environments/${name}` },
      ]),
    ),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  });
  // Every environment sits at the same depth, so one relative path serves
  // each configuration.
  const environmentFolder = join(
    workspaceRoot,
    root,
    'src/environments',
    environments[0],
  );
  const check = relative(environmentFolder, checkPlanFresh);
  const projectRoot = relative(environmentFolder, join(workspaceRoot, root));
  return {
    format: {
      executor: 'nx:run-commands',
      options: { command: 'tofu fmt -recursive', cwd: '{projectRoot}/src' },
    },
    'format:check': {
      executor: 'nx:run-commands',
      options: {
        command: 'tofu fmt -check -recursive',
        cwd: '{projectRoot}/src',
      },
      cache: true,
      inputs,
    },
    // `-lockfile=readonly`: a check never writes (ADR 0002), and `init` is
    // the target that records a provider change. `TF_DATA_DIR` keeps this
    // backend-less init out of the working directory of the real `init`.
    typecheck: {
      executor: 'nx:run-commands',
      options: {
        command: environments
          .map(
            (name) =>
              `tofu -chdir=environments/${name} init -backend=false -input=false -lockfile=readonly && tofu -chdir=environments/${name} validate`,
          )
          .join(' && '),
        cwd: '{projectRoot}/src',
        env: { TF_DATA_DIR: '.terraform/validate' },
      },
      cache: true,
      inputs,
    },
    init: inEnvironment(`${passphrase} tofu init -input=false`),
    preview: inEnvironment(
      `rm -f tfplan && ${passphrase} tofu plan -out tfplan`,
      ['init'],
    ),
    show: inEnvironment(
      `node "${check}" "${projectRoot}" && ${passphrase} tofu show tfplan`,
    ),
    output: inEnvironment(`${passphrase} tofu output`),
  };
}
