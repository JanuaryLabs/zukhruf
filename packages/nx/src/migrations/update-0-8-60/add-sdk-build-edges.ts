import { isDeepStrictEqual } from 'node:util';

import {
  type TargetConfiguration,
  type Tree,
  formatFiles,
  getProjects,
  joinPathFragments,
  logger,
} from '@nx/devkit';

import {
  buildDepsTarget,
  clientManifest,
} from '../../generators/node-app/files.ts';
import {
  type ProjectManifest,
  projectRootsWith,
  updateJsonIfChanged,
} from '../workspace.ts';

/** The client stub as node-app writes it today. */
interface TodayClient {
  nx: {
    implicitDependencies: string[];
    targets: {
      sdk: Required<Pick<TargetConfiguration, 'dependsOn' | 'inputs'>>;
    };
  };
}

/** A client stub in a repo: sdk-it never writes its `nx` block, a developer may. */
interface ClientManifest {
  name: string;
  nx?: {
    implicitDependencies?: string[];
    targets?: Record<string, TargetConfiguration>;
  };
}

/** The inputs of the client's sdk as node-app wrote them up to 0.8.59. */
const oldSdkInputs = (backend: string) => [
  { projects: [backend], input: 'production' },
  '{workspaceRoot}/package-lock.json',
  '{projectRoot}/package.json',
];

/**
 * #5102: the sdk-it client reads the backend's types, and through them a db
 * package's generated client, but imports neither. Each backend gets
 * `build-deps`; its client gets the implicit dependency on the backend, and
 * its sdk runs `^build-deps` first and hashes the backend's production files
 * and its dependencies' generated `.ts`. A client whose sdk is not the shape
 * node-app wrote is logged, not edited (ADR 0017 decision 5).
 */
export default async function addSdkBuildEdges(tree: Tree): Promise<void> {
  const roots = new Set(projectRootsWith(tree, 'sdk-it.config.ts'));
  for (const [backend, { root }] of getProjects(tree)) {
    if (!roots.has(root)) continue;
    updateBuildDeps(tree, joinPathFragments(root, 'package.json'), backend);
    updateClient(
      tree,
      joinPathFragments(root, '.sdk-it/package.json'),
      backend,
    );
  }
  await formatFiles(tree);
}

function updateBuildDeps(tree: Tree, path: string, backend: string): void {
  updateJsonIfChanged<ProjectManifest>(tree, path, (manifest) => {
    const targets = manifest.nx?.targets;
    const own = targets?.['build-deps'];
    if (targets !== undefined && own === undefined) {
      targets['build-deps'] = buildDepsTarget;
    } else if (!isDeepStrictEqual(own, buildDepsTarget)) {
      logger.warn(
        `add-sdk-build-edges: ${backend}:build-deps in ${path} is ${JSON.stringify(own)}, and its client's sdk runs it first to build ${backend}'s dependencies: make it ${JSON.stringify(buildDepsTarget)} (#5102).`,
      );
    }
  });
}

function updateClient(tree: Tree, path: string, backend: string): void {
  if (!tree.exists(path)) {
    logger.warn(
      `add-sdk-build-edges: ${path} is not there, so the sdk-it client of ${backend} gets no edge to it. Run nx g @zukhruf/nx:node-app again to write the stub (#5102).`,
    );
    return;
  }
  updateJsonIfChanged<ClientManifest>(tree, path, (manifest) => {
    const today: TodayClient = JSON.parse(
      clientManifest(manifest.name, backend),
    );
    const { nx } = manifest;
    const sdk = nx?.targets?.['sdk'];
    const wanted = today.nx.targets.sdk;
    if (
      isDeepStrictEqual(
        nx?.implicitDependencies,
        today.nx.implicitDependencies,
      ) &&
      isDeepStrictEqual(sdk?.dependsOn, wanted.dependsOn) &&
      isDeepStrictEqual(sdk?.inputs, wanted.inputs)
    ) {
      return;
    }
    if (
      nx === undefined ||
      sdk === undefined ||
      nx.implicitDependencies !== undefined ||
      sdk.dependsOn !== undefined ||
      !isDeepStrictEqual(sdk.inputs, oldSdkInputs(backend))
    ) {
      logger.warn(
        `add-sdk-build-edges: the sdk target of ${path} is not the one node-app wrote, so it stays. Set "implicitDependencies": ${JSON.stringify(today.nx.implicitDependencies)} in its nx block, and replace the sdk's dependsOn with ${JSON.stringify(wanted.dependsOn)} and its inputs with ${JSON.stringify(wanted.inputs)}, so the db generator runs before sdk-it and a schema change makes a new client (#5102).`,
      );
      return;
    }
    nx.implicitDependencies = today.nx.implicitDependencies;
    sdk.dependsOn = wanted.dependsOn;
    sdk.inputs = wanted.inputs;
  });
}
