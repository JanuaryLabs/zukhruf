import { type Tree, formatFiles, readJson, updateJson } from '@nx/devkit';

import { appDirectory, projectNameOf } from '../app-directory.ts';
import { dockerfile } from '../node-app/files.ts';
import { appPackageVersions as versions } from '../versions.ts';
import {
  apiTs,
  legacyUiMount,
  uiMount,
  uiRootEnvTs,
  uiRouteImport,
  uiRouteTs,
} from './files.ts';

export interface PairOptions {
  /** The project root of a node-app, for example `apps/backend`. */
  api: string;
  /** The project root of a react-app, for example `apps/web`. */
  web: string;
}

/** PORT is the generator's line in .env.example, so it is the one line worth reading. */
export function portOf(tree: Tree, apiRoot: string): number {
  const example = tree.read(`${apiRoot}/.env.example`, 'utf-8') ?? '';
  const match = /^PORT=(\d+)$/m.exec(example);
  return match ? Number(match[1]) : 3000;
}

/**
 * app.ts mounts the UI route only when UI_ROOT is set, and env.ts declares it.
 * The mount that pair wrote before UI_ROOT is replaced.
 */
function mountUi(tree: Tree, apiRoot: string): void {
  const appPath = `${apiRoot}/src/app.ts`;
  const app = tree.read(appPath, 'utf-8');
  if (app === null) {
    throw new Error(`${appPath} does not exist.`);
  }
  if (app.includes(legacyUiMount)) {
    tree.write(appPath, app.replace(legacyUiMount, uiMount));
  } else if (!app.includes(uiRouteImport)) {
    const marker = '\napp.notFound((c) =>';
    if (!app.includes(marker)) {
      throw new Error(`${appPath} has no app.notFound registration.`);
    }
    tree.write(appPath, app.replace(marker, `\n${uiMount}\n${marker}`));
  }
  const envPath = `${apiRoot}/src/env.ts`;
  const env = tree.read(envPath, 'utf-8') ?? '';
  if (!env.includes('UI_ROOT:')) {
    const marker = 'const env = z.object({\n';
    if (!env.includes(marker)) {
      throw new Error(
        `${envPath} has no ${JSON.stringify(marker)}, so the generator cannot declare UI_ROOT in it.`,
      );
    }
    tree.write(envPath, env.replace(marker, `${marker}${uiRootEnvTs}`));
  }
  tree.write(`${apiRoot}/src/routes/ui.route.ts`, uiRouteTs);
}

/**
 * Pairs a react-app with a node-app: the web gets the generated client, and
 * the api serves the web build and puts it in its image. The app generators
 * never name each other, so pairing is one explicit step that is safe to run
 * again. The web depends on the api only through the client library: an
 * app-to-app edge would make dependency-checks ask the web for the runtime
 * dependencies of the api, and fail @nx/enforce-module-boundaries.
 */
export default async function pairGenerator(
  tree: Tree,
  options: PairOptions,
): Promise<void> {
  const apiRoot = appDirectory(options.api).projectRoot;
  const webRoot = appDirectory(options.web).projectRoot;
  if (!tree.exists(`${apiRoot}/sdk-it.config.ts`)) {
    throw new Error(
      `${apiRoot} has no sdk-it.config.ts, so it is not a node-app. Run @zukhruf/nx:node-app ${apiRoot} first.`,
    );
  }
  if (!tree.exists(`${webRoot}/vite.config.ts`)) {
    throw new Error(
      `${webRoot} has no vite.config.ts, so it is not a react-app. Run @zukhruf/nx:react-app ${webRoot} first.`,
    );
  }
  const apiName = projectNameOf(tree, apiRoot);
  const webName = projectNameOf(tree, webRoot);
  const client = readJson<{ name: string }>(
    tree,
    `${apiRoot}/.sdk-it/package.json`,
  );

  updateJson(
    tree,
    `${webRoot}/package.json`,
    (packageJson: { dependencies?: Record<string, string> }) => {
      // The web bundles the client, so the runtime dependencies of the client
      // are in the manifest of the web (dependency-checks of a bundled app).
      packageJson.dependencies = {
        ...packageJson.dependencies,
        [client.name]: '*',
        'fast-content-type-parse': versions['fast-content-type-parse'],
        zod: versions.zod,
      };
      return packageJson;
    },
  );
  tree.write(`${webRoot}/src/api.ts`, apiTs(client.name));
  mountUi(tree, apiRoot);
  tree.write(
    `${apiRoot}/Dockerfile`,
    dockerfile({
      projectRoot: apiRoot,
      projectName: apiName,
      port: portOf(tree, apiRoot),
      workspaces:
        readJson<{ workspaces?: string[] }>(tree, 'package.json').workspaces ??
        [],
      spa: { projectName: webName, projectRoot: webRoot },
    }),
  );

  await formatFiles(tree);
}
