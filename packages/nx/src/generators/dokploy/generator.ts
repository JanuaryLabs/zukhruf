import {
  type NxJsonConfiguration,
  type Tree,
  formatFiles,
  updateJson,
  writeJson,
} from '@nx/devkit';

import { addLines } from '../add-lines.ts';
import { appDirectory, projectNameOf } from '../app-directory.ts';
import { pluginName } from '../init/nx-json.ts';
import { portOf } from '../pair/generator.ts';
import { workspaceScope } from '../workspace-scope.ts';
import {
  backendTf,
  ciYml,
  composeYml,
  deployYml,
  dnsTf,
  dockerignore,
  encryptionTf,
  envExample,
  gitignore,
  infraRoot,
  lockHcl,
  mainTf,
  nxignore,
  outputsTf,
  prettierignore,
  providersTf,
  variablesTf,
  versionsTf,
  zizmorYml,
} from './files.ts';

export interface DokployOptions {
  /** The project root of a node-app, for example `apps/backend`. */
  api: string;
  /** The GitHub owner of the repo. The images are `ghcr.io/<owner>/<name>-<app>`. */
  owner: string;
  /** The Dokploy project, the prefix of the images and of the Traefik routers. The workspace scope by default. */
  name?: string;
  /** The Dokploy API base URL. */
  dokployHost?: string;
  /** The Hetzner Cloud server that runs Dokploy. */
  server?: string;
  /** A DNS name in a Hetzner zone, for example `app.example.com`. Without it, the host is `<name>.<ipv4>.sslip.io`. */
  host?: string;
  /** The Hetzner zone of `host`. The host without its first label by default. */
  zone?: string;
  /** The project root of a Prisma package with a `Dockerfile.migration`, for example `packages/db`. It adds Postgres and the migrate service. */
  database?: string;
  /** The GitHub user whose classic token with read:packages is the GHCR_PULL_TOKEN secret. It adds a Dokploy registry, so the server pulls private images. */
  registryUser?: string;
}

/** A name that a Hetzner DNS record points to the server. */
export interface DnsHost {
  kind: 'dns';
  host: string;
  zone: string;
  /** The record name in the zone: the host without `.<zone>`. */
  record: string;
}

/** `<name>.<ipv4>.sslip.io`, which resolves to the server with no record. */
export interface SslipHost {
  kind: 'sslip';
}

/** Postgres and the one-shot migrate service of a Prisma package. */
export interface Database {
  root: string;
  projectName: string;
  /** The Postgres user and database. */
  role: string;
}

/** The Dokploy registry that logs the server in to GHCR. */
export interface Registry {
  username: string;
}

/** What the generated stack needs, read from the options and the workspace. */
export interface Stack {
  name: string;
  /** The Nx project name of the stack, `@<scope>/infra`. */
  projectName: string;
  /** The GitHub owner in lowercase: GHCR refuses an upper-case name. */
  owner: string;
  app: {
    /** The last segment of the project root: the compose and the image name. */
    name: string;
    root: string;
    port: number;
    /** The projects whose change gives a new image: the projects that the Dockerfile builds, and the Prisma package. */
    imageProjects: string[];
  };
  dokployHost: string;
  server: string;
  host: DnsHost | SslipHost;
  database?: Database;
  registry?: Registry;
}

const environment = `${infraRoot}/src/environments/production`;
const identifier = /^[a-z][a-z0-9-]*$/;

function hostOf(options: DokployOptions): DnsHost | SslipHost {
  if (options.host === undefined) {
    if (options.zone !== undefined) {
      throw new Error(
        `The zone ${JSON.stringify(options.zone)} needs a host in it. Give --host, or drop --zone for an sslip.io host.`,
      );
    }
    return { kind: 'sslip' };
  }
  const host = options.host.toLowerCase();
  const zone = (
    options.zone ?? host.split('.').slice(1).join('.')
  ).toLowerCase();
  if (zone === '' || !host.endsWith(`.${zone}`)) {
    throw new Error(
      `The host ${JSON.stringify(host)} is not a name in the zone ${JSON.stringify(zone)}.`,
    );
  }
  return { kind: 'dns', host, zone, record: host.slice(0, -zone.length - 1) };
}

/** The projects that the image builds: the `--projects` list of the Dockerfile that node-app and pair write. */
function builtProjects(dockerfile: string, projectName: string): string[] {
  const list = /--projects (\S+)/.exec(dockerfile)?.[1];
  return list === undefined ? [projectName] : list.split(',');
}

function databaseOf(tree: Tree, root: string, name: string): Database {
  const projectRoot = appDirectory(root).projectRoot;
  if (!tree.exists(`${projectRoot}/Dockerfile.migration`)) {
    throw new Error(
      `${projectRoot} has no Dockerfile.migration, so it is not a Prisma package. Run @zukhruf/nx:prisma ${projectRoot} first.`,
    );
  }
  return {
    root: projectRoot,
    projectName: projectNameOf(tree, projectRoot),
    role: name.replaceAll('-', '_'),
  };
}

function stackOf(tree: Tree, options: DokployOptions): Stack {
  const scope = workspaceScope(tree);
  const name = options.name ?? scope;
  if (!identifier.test(name)) {
    throw new Error(
      `The name ${JSON.stringify(name)} is not a lowercase name that starts with a letter. Give --name.`,
    );
  }
  const { projectRoot, name: appName } = appDirectory(options.api);
  const dockerfile = tree.read(`${projectRoot}/Dockerfile`, 'utf-8');
  if (dockerfile === null) {
    throw new Error(
      `${projectRoot} has no Dockerfile, so it is not a node-app. Run @zukhruf/nx:node-app ${projectRoot} first.`,
    );
  }
  if (!identifier.test(appName)) {
    throw new Error(
      `The app folder ${JSON.stringify(appName)} is not a lowercase name that starts with a letter.`,
    );
  }
  const owner = options.owner.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(owner)) {
    throw new Error(
      `The owner ${JSON.stringify(options.owner)} is not a GitHub user or organization.`,
    );
  }
  const database =
    options.database === undefined
      ? undefined
      : databaseOf(tree, options.database, name);
  return {
    name,
    projectName: `@${scope}/${infraRoot}`,
    owner,
    app: {
      name: appName,
      root: projectRoot,
      port: portOf(tree, projectRoot),
      imageProjects: [
        ...builtProjects(dockerfile, projectNameOf(tree, projectRoot)),
        ...(database ? [database.projectName] : []),
      ],
    },
    dokployHost: options.dokployHost ?? 'https://dokploy.limerence.sh/api',
    server: options.server ?? 'limerence-dokploy',
    host: hostOf(options),
    ...(database ? { database } : {}),
    ...(options.registryUser === undefined
      ? {}
      : { registry: { username: options.registryUser } }),
  };
}

/** @zukhruf/nx/opentofu gives the infra project its targets; it comes after @zukhruf/nx/format, whose targets it replaces. */
function addOpentofuPlugin(tree: Tree): void {
  updateJson(tree, 'nx.json', (nxJson: NxJsonConfiguration) => {
    const plugins = [...(nxJson.plugins ?? [])];
    if (plugins.some((entry) => pluginName(entry) === '@zukhruf/nx/opentofu')) {
      return nxJson;
    }
    const format = plugins.findIndex(
      (entry) => pluginName(entry) === '@zukhruf/nx/format',
    );
    plugins.splice(
      format === -1 ? plugins.length : format + 1,
      0,
      '@zukhruf/nx/opentofu',
    );
    nxJson.plugins = plugins;
    return nxJson;
  });
}

/**
 * The GitOps delivery of a node-app on Dokploy: an OpenTofu project in
 * `infra/` whose main.tf calls zukhruf's dokploy-stack module to store the
 * compose in Dokploy, and the CI and deploy workflows that build the images,
 * apply the stack through zukhruf's tofu-apply workflow and roll it out with
 * its dokploy-deploy and wait-for-health actions. Each file is written once:
 * a second run changes nothing and keeps the repo's edits.
 */
export default async function dokployGenerator(
  tree: Tree,
  options: DokployOptions,
): Promise<void> {
  const stack = stackOf(tree, options);

  // Once written, each file of infra/ and each workflow is the repo's: a run
  // writes a file only when it is missing, and never deletes one (ADR 0015).
  if (!tree.exists(`${infraRoot}/project.json`)) {
    writeJson(tree, `${infraRoot}/project.json`, {
      name: stack.projectName,
      $schema: '../node_modules/nx/schemas/project-schema.json',
      sourceRoot: `${infraRoot}/src`,
      projectType: 'application',
    });
  }
  for (const [path, content] of [
    [`${infraRoot}/.gitignore`, gitignore],
    [`${infraRoot}/.env.example`, envExample(stack)],
    [`${infraRoot}/compose.dokploy.yml`, composeYml(stack)],
    [`${environment}/versions.tf`, versionsTf],
    [`${environment}/backend.tf`, backendTf],
    [`${environment}/encryption.tf`, encryptionTf(stack)],
    [`${environment}/providers.tf`, providersTf(stack)],
    [`${environment}/dns.tf`, dnsTf(stack)],
    [`${environment}/main.tf`, mainTf(stack)],
    [`${environment}/outputs.tf`, outputsTf(stack)],
    [`${environment}/variables.tf`, variablesTf(stack)],
    [`${environment}/.terraform.lock.hcl`, lockHcl],
    ['.github/workflows/ci.yml', ciYml(stack)],
    ['.github/workflows/deploy.yml', deployYml(stack)],
    ['.github/zizmor.yml', zizmorYml],
  ] as const) {
    if (!tree.exists(path)) {
      tree.write(path, content);
    }
  }
  addLines(tree, '.prettierignore', prettierignore);
  addLines(tree, '.nxignore', nxignore);
  addLines(tree, '.dockerignore', dockerignore);
  addOpentofuPlugin(tree);

  await formatFiles(tree);
}
