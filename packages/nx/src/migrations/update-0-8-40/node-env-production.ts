import {
  type NxJsonConfiguration,
  type Tree,
  formatFiles,
  joinPathFragments,
  logger,
} from '@nx/devkit';

import { envMarker, infraRoot } from '../../generators/dokploy/files.ts';
import { addEnvEntry } from '../../generators/env-file.ts';
import { addProductionNodeEnvDefaults } from '../../generators/init/nx-json.ts';
import {
  type ProjectManifest,
  hasPlugin,
  projectRootsWith,
  sourceFiles,
  updateJsonIfChanged,
} from '../workspace.ts';

const envComment =
  '# Every setup runs under production; no code reads NODE_ENV (ADR 0016).';

/**
 * #4833, ADR 0016: NODE_ENV is production in every setup, and code never
 * reads it. A repo gets the configuration that the generators write now: the
 * nx.json defaults of test and serve, the env of the generated targets, the
 * web's two exceptions, NODE_ENV in each .env.example, the workflow env, and
 * ALLOWED_ORIGINS in the production env of dokploy. A value that is there
 * stays, except the development that the backend's generated targets set
 * before. Source code is not rewritten: each NODE_ENV read is logged with its
 * file and line, and zukhruf/no-node-env refuses it.
 */
export default async function nodeEnvProduction(tree: Tree): Promise<void> {
  const backends = projectRootsWith(tree, 'sdk-it.config.ts');
  const dbPackages = projectRootsWith(tree, 'prisma.config.ts');
  // A react-app has an index.html beside its vite.config.ts; a ui-package, a
  // Vite library, has none and gets no dev server.
  const webs = hasPlugin(tree, '@nx/vite/plugin')
    ? projectRootsWith(tree, 'vite.config.ts').filter((root) =>
        tree.exists(joinPathFragments(root, 'index.html')),
      )
    : [];
  if (backends.length + dbPackages.length + webs.length === 0) return;

  if (tree.exists('nx.json')) {
    updateJsonIfChanged<NxJsonConfiguration>(
      tree,
      'nx.json',
      addProductionNodeEnvDefaults,
    );
  }
  for (const root of backends) {
    setTargetEnv(tree, root, ['serve', 'auth:generate', 'auth:check'], {
      value: 'production',
      replaces: 'development',
    });
    setTargetEnv(tree, joinPathFragments(root, '.sdk-it'), ['sdk'], {
      value: 'production',
    });
    addNodeEnvLine(tree, root);
  }
  for (const root of dbPackages) {
    setTargetEnv(tree, root, ['up'], { value: 'production' });
    addNodeEnvLine(tree, root);
  }
  for (const root of webs) addWebExceptions(tree, root);
  addNodeEnvLine(tree, infraRoot);
  for (const workflow of ['ci.yml', 'deploy.yml']) {
    addWorkflowEnv(tree, joinPathFragments('.github/workflows', workflow));
  }
  addAllowedOrigins(tree);
  logNodeEnvReads(tree);
  await formatFiles(tree);
}

/**
 * Sets NODE_ENV in the env of each named target that the project's
 * package.json has. A NODE_ENV that is there stays, unless it is `replaces`,
 * the value the generator wrote before.
 */
function setTargetEnv(
  tree: Tree,
  root: string,
  targets: string[],
  { value, replaces }: { value: string; replaces?: string },
): void {
  const path = joinPathFragments(root, 'package.json');
  if (!tree.exists(path)) return;
  updateJsonIfChanged<ProjectManifest>(tree, path, (manifest) => {
    for (const name of targets) {
      const target = manifest.nx?.targets?.[name];
      if (target === undefined) continue;
      const env: Record<string, string> = { ...target.options?.env };
      if (env['NODE_ENV'] === undefined || env['NODE_ENV'] === replaces) {
        env['NODE_ENV'] = value;
      }
      target.options = { ...target.options, env };
    }
  });
}

/**
 * The web's two exceptions (ADR 0016): Vite turns React Fast Refresh off under
 * production, so dev and serve run under development, and Testing Library
 * renders through act(), which production React does not have, so test runs
 * under test. A target with an env of its own keeps it.
 */
function addWebExceptions(tree: Tree, root: string): void {
  const path = joinPathFragments(root, 'package.json');
  updateJsonIfChanged<ProjectManifest>(tree, path, (manifest) => {
    const targets = { ...manifest.nx?.targets };
    for (const [name, value] of [
      ['dev', 'development'],
      ['serve', 'development'],
      ['test', 'test'],
    ] as const) {
      const target = targets[name] ?? {};
      if (target.options?.env !== undefined) continue;
      targets[name] = {
        ...target,
        options: { ...target.options, env: { NODE_ENV: value } },
      };
    }
    manifest.nx = { ...manifest.nx, targets };
  });
}

/** NODE_ENV=production in the .env.example of `root`, and in its .env where it is. */
function addNodeEnvLine(tree: Tree, root: string): void {
  for (const file of ['.env.example', '.env']) {
    const path = joinPathFragments(root, file);
    const content = tree.read(path, 'utf-8');
    if (content === null || /^NODE_ENV=/m.test(content)) continue;
    const separator = content === '' || content.endsWith('\n') ? '' : '\n';
    tree.write(path, `${content}${separator}${envComment}\n`);
    addEnvEntry(tree, path, 'NODE_ENV', 'production');
  }
}

/**
 * NODE_ENV: production and npm_config_include: dev in the workflow-level env
 * of a workflow that dokploy writes. npm omits devDependencies under
 * NODE_ENV=production, and CI needs them.
 */
function addWorkflowEnv(tree: Tree, path: string): void {
  const content = tree.read(path, 'utf-8');
  if (content === null) return;
  const lines = [
    ...(/^ {2}NODE_ENV:/m.test(content)
      ? []
      : [
          '  # Every setup runs under production (ADR 0016 of @zukhruf/nx).',
          '  NODE_ENV: production',
        ]),
    ...(/^ {2}npm_config_include:/m.test(content)
      ? []
      : [
          '  # npm omits devDependencies under NODE_ENV=production; CI needs them.',
          '  npm_config_include: dev',
        ]),
  ];
  if (lines.length === 0) return;
  if (/^env:\n/m.test(content)) {
    tree.write(
      path,
      content.replace(/^env:\n/m, `env:\n${lines.join('\n')}\n`),
    );
  } else if (/^jobs:/m.test(content)) {
    tree.write(
      path,
      content.replace(/^jobs:/m, `env:\n${lines.join('\n')}\n\njobs:`),
    );
  } else {
    logger.warn(
      `node-env-production: ${path} has no workflow-level env and no jobs key, so it got no edit. Add "env: { NODE_ENV: production, npm_config_include: dev }" at its top level (ADR 0016 of @zukhruf/nx).`,
    );
  }
}

/**
 * ALLOWED_ORIGINS in the production env of the dokploy infra: the generated
 * backend now always derives the better-auth baseURL from its hosts, and
 * better-auth refuses an empty list. The comment line ends the alignment
 * group of tofu fmt, as the auth generator's lines do.
 */
function addAllowedOrigins(tree: Tree): void {
  const path = joinPathFragments(
    infraRoot,
    'src/environments/production/main.tf',
  );
  const content = tree.read(path, 'utf-8');
  if (content === null || /^\s+ALLOWED_ORIGINS\s*=/m.test(content)) return;
  const marker = new RegExp(`^( +)${escape(envMarker)}$`, 'm');
  if (!marker.test(content)) {
    logger.warn(
      `node-env-production: ${path} has no "${envMarker}" line, so it got no ALLOWED_ORIGINS. Add ALLOWED_ORIGINS = "https://\${local.host}" to the env map of module "stack": the backend derives the better-auth baseURL from it (ADR 0016 of @zukhruf/nx).`,
    );
    return;
  }
  tree.write(
    path,
    content.replace(
      marker,
      (line: string, indent: string) =>
        `${indent}# The public origin: CORS and better-auth trust it (ADR 0016).\n${indent}ALLOWED_ORIGINS = "https://\${local.host}"\n${line}`,
    ),
  );
}

// The reads that zukhruf/no-node-env reports, as text. A write
// (`process.env.NODE_ENV = …`) is not a read.
const nodeEnvRead =
  /process\.env(?:\.NODE_ENV|\[\s*['"`]NODE_ENV['"`]\s*\])(?!\s*=[^=])|import\.meta\.env\.NODE_ENV|\{[^}]*\bNODE_ENV\b[^}]*\}\s*=\s*process\.env/;

/** Logs each NODE_ENV read in source, which the code change must replace by hand. */
function logNodeEnvReads(tree: Tree): void {
  const reads: string[] = [];
  for (const path of sourceFiles(tree)) {
    if (path.includes('/node_modules/') || path.endsWith('.d.ts')) continue;
    const lines = (tree.read(path, 'utf-8') ?? '').split('\n');
    lines.forEach((line, index) => {
      if (nodeEnvRead.test(line)) reads.push(`${path}:${index + 1}`);
    });
  }
  if (reads.length === 0) return;
  logger.warn(
    `node-env-production: ${reads.length} NODE_ENV reads in source, which zukhruf/no-node-env refuses. Give each behavior its own setting (ALLOWED_ORIGINS, HOST, LOG_DIR, LOG_PRETTY, UI_ROOT), as ADR 0016 of @zukhruf/nx lists:\n${reads.join('\n')}`,
  );
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
