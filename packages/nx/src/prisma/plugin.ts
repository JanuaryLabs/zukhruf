import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';

import {
  type CreateNodes,
  type TargetConfiguration,
  createNodesFromFiles,
} from '@nx/devkit';

import { nearestRoot, projectRootFiles } from '../project-roots.ts';

// The migration diff ships beside this file: `.ts` in the source that zukhruf
// runs, `.js` in the build that npm installs.
const migrateDiff = join(
  import.meta.dirname,
  `migrate-diff${extname(import.meta.filename)}`,
);

const generatorBlock = /^\s*generator\s+\w+\s*\{([^}]*)\}/gm;
const outputLine = /^\s*output\s*=\s*"([^"]+)"/m;

/**
 * Gives the Prisma targets to each project root with a `prisma.config.ts`.
 * `generate` is cached: its inputs are the schema files, the config and the
 * Prisma packages, and its outputs are the `output` folders of the generator
 * blocks. `migrate:check` is cached on the schema files and the migrations.
 * It does not change `typecheck` or `build` (ADR 0001).
 */
export const createNodes: CreateNodes = [
  '{package.json,**/package.json,project.json,**/project.json,prisma.config.ts,**/prisma.config.ts,**/*.prisma}',
  (files, options, context) => {
    const rootFiles = projectRootFiles(
      files.filter((file) =>
        ['package.json', 'project.json'].includes(basename(file)),
      ),
      context.workspaceRoot,
    );
    const roots = new Set(rootFiles.map((file) => dirname(file)));
    const configured = new Set(
      files
        .filter((file) => basename(file) === 'prisma.config.ts')
        .map((file) => dirname(file)),
    );
    const schemas = new Map<string, string[]>();
    for (const file of files.filter((file) => file.endsWith('.prisma'))) {
      const root = nearestRoot(roots, dirname(file));
      if (root !== undefined) {
        schemas.set(root, [...(schemas.get(root) ?? []), file]);
      }
    }
    return createNodesFromFiles(
      (file) => {
        const root = dirname(file);
        return configured.has(root)
          ? {
              projects: {
                [root]: {
                  targets: targets(
                    root,
                    relative(join(context.workspaceRoot, root), migrateDiff),
                    generatorOutputs(
                      context.workspaceRoot,
                      schemas.get(root) ?? [],
                    ),
                  ),
                },
              },
            }
          : {};
      },
      rootFiles,
      options,
      context,
    );
  },
];

// Each `output` is relative to the file of its generator block, as Prisma
// reads it. `undefined` marks a block with no `output`: Prisma then writes
// into node_modules, which Nx cannot restore from its cache.
function generatorOutputs(workspaceRoot: string, schemas: string[]) {
  return schemas.flatMap((schema) =>
    [
      ...readFileSync(join(workspaceRoot, schema), 'utf8').matchAll(
        generatorBlock,
      ),
    ].map(([, body = '']) => {
      const output = outputLine.exec(body)?.[1];
      return output === undefined ? undefined : join(dirname(schema), output);
    }),
  );
}

function targets(
  root: string,
  script: string,
  outputs: (string | undefined)[],
): Record<string, TargetConfiguration> {
  const command = (line: string, dependsOn: string[] = []) => ({
    executor: 'nx:run-commands',
    options: { command: line, cwd: '{projectRoot}' },
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  });
  const folders = outputs.filter((output) => output !== undefined);
  return {
    generate: {
      ...command('prisma generate'),
      inputs: [
        '{projectRoot}/**/*.prisma',
        '{projectRoot}/prisma.config.ts',
        { externalDependencies: ['prisma', '@prisma/client'] },
      ],
      ...(folders.length > 0 && folders.length === outputs.length
        ? {
            cache: true,
            outputs: [...new Set(folders)].map((folder) =>
              relative(root, folder).startsWith('..')
                ? `{workspaceRoot}/${folder}`
                : `{projectRoot}/${relative(root, folder)}`,
            ),
          }
        : { cache: false }),
    },
    migrate: command('prisma migrate dev', ['generate']),
    // Both diff the migrations on a shadow database that the script makes
    // (ADR 0018). The check only reads, so it is cached.
    'migrate:check': {
      ...command(`node "${script}" check`),
      cache: true,
      inputs: [
        '{projectRoot}/**/*.prisma',
        '{projectRoot}/prisma.config.ts',
        '{projectRoot}/migrations/**/*',
        { externalDependencies: ['prisma'] },
      ],
    },
    'migrate:create': command(`node "${script}" create`),
    deploy: command('prisma migrate deploy'),
    reset: command('prisma migrate reset'),
    pull: command('prisma db pull'),
  };
}
