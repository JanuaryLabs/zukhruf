import { isDeepStrictEqual } from 'node:util';

import {
  type TargetConfiguration,
  type Tree,
  formatFiles,
  getProjects,
  joinPathFragments,
  logger,
  readJson,
  writeJson,
} from '@nx/devkit';

import {
  buildDepsTarget,
  clientManifest,
} from '../../generators/node-app/files.ts';
import { type ProjectManifest, projectRootsWith } from '../workspace.ts';

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
 * What one file of a backend and its client needs: nothing, the edit of a file
 * in the shape node-app wrote, or a step by hand for a file that lost it.
 */
type Plan<T> =
  | { kind: 'current' }
  | { kind: 'edit'; manifest: T; step: string }
  | { kind: 'by-hand'; reason: string; step: string };

/**
 * #5102: the sdk-it client reads the backend's types, and through them a db
 * package's generated client, but imports neither. Each backend gets
 * `build-deps`; its client gets the implicit dependency on the backend, and
 * its sdk runs `^build-deps` first and hashes the backend's production files
 * and its dependencies' generated `.ts`. The two edits are one change: when
 * either file is not the shape node-app wrote, or the client has no stub,
 * neither file changes and one log names both edits (ADR 0017 decision 5).
 */
export default async function addSdkBuildEdges(tree: Tree): Promise<void> {
  const roots = new Set(projectRootsWith(tree, 'sdk-it.config.ts'));
  for (const [backend, { root }] of getProjects(tree)) {
    if (!roots.has(root)) continue;
    const backendPath = joinPathFragments(root, 'package.json');
    const clientPath = joinPathFragments(root, '.sdk-it/package.json');
    const build = buildDepsPlan(
      readJson(tree, backendPath),
      backendPath,
      backend,
    );
    const client = tree.exists(clientPath)
      ? clientPlan(readJson(tree, clientPath), clientPath, backend)
      : missingClient(clientPath, backend);
    const plans = [build, client];
    const reasons = plans.flatMap((plan) =>
      plan.kind === 'by-hand' ? [plan.reason] : [],
    );
    if (reasons.length > 0) {
      const steps = plans.flatMap((plan) =>
        plan.kind === 'current' ? [] : [plan.step],
      );
      logger.warn(
        `add-sdk-build-edges: ${reasons.join(', and ')}, so ${backendPath} and ${clientPath} stay as they are. ${steps.join(' ')} (#5102).`,
      );
      continue;
    }
    if (build.kind === 'edit') writeJson(tree, backendPath, build.manifest);
    if (client.kind === 'edit') writeJson(tree, clientPath, client.manifest);
  }
  await formatFiles(tree);
}

function buildDepsPlan(
  manifest: ProjectManifest,
  path: string,
  backend: string,
): Plan<ProjectManifest> {
  const targets = manifest.nx?.targets;
  const own = targets?.['build-deps'];
  if (isDeepStrictEqual(own, buildDepsTarget)) return { kind: 'current' };
  const step = `In ${path}, set "build-deps": ${JSON.stringify(buildDepsTarget)} in nx.targets: the client's sdk runs it first to build ${backend}'s dependencies.`;
  if (targets === undefined || own !== undefined) {
    return {
      kind: 'by-hand',
      reason: `${backend}:build-deps in ${path} is ${JSON.stringify(own)}`,
      step,
    };
  }
  targets['build-deps'] = buildDepsTarget;
  return { kind: 'edit', manifest, step };
}

function clientPlan(
  manifest: ClientManifest,
  path: string,
  backend: string,
): Plan<ClientManifest> {
  const today: TodayClient = JSON.parse(clientManifest(manifest.name, backend));
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
    return { kind: 'current' };
  }
  const step = `In ${path}, set "implicitDependencies": ${JSON.stringify(today.nx.implicitDependencies)} in its nx block, and replace the sdk's dependsOn with ${JSON.stringify(wanted.dependsOn)} and its inputs with ${JSON.stringify(wanted.inputs)}, so the db generator runs before sdk-it and a schema change makes a new client.`;
  if (
    nx === undefined ||
    sdk === undefined ||
    nx.implicitDependencies !== undefined ||
    sdk.dependsOn !== undefined ||
    !isDeepStrictEqual(sdk.inputs, oldSdkInputs(backend))
  ) {
    return {
      kind: 'by-hand',
      reason: `the sdk target of ${path} is not the one node-app wrote`,
      step,
    };
  }
  nx.implicitDependencies = today.nx.implicitDependencies;
  sdk.dependsOn = wanted.dependsOn;
  sdk.inputs = wanted.inputs;
  return { kind: 'edit', manifest, step };
}

function missingClient(path: string, backend: string): Plan<ClientManifest> {
  return {
    kind: 'by-hand',
    reason: `${backend} has no sdk-it client package at ${path}`,
    step: `A web that reads the API another way (such as @sdk-it/vite) needs its readers to run after the generators that the backend's types read.`,
  };
}
