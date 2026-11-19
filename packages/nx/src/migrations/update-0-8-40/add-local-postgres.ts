import {
  type Tree,
  formatFiles,
  joinPathFragments,
  logger,
  offsetFromRoot,
  readJson,
} from '@nx/devkit';

import { addMissingKeys } from '../../generators/add-keys.ts';
import { addEnvEntry } from '../../generators/env-file.ts';
import { unique } from '../../generators/init/nx-json.ts';
import {
  type LocalDatabase,
  composeDevYml,
  localConnectionString,
} from '../../generators/prisma/files.ts';
import { localDatabaseTargets } from '../../generators/prisma/generator.ts';
import { workspaceScope } from '../../generators/workspace-scope.ts';
import {
  type ProjectManifest,
  envValue,
  projectRootsWith,
  sourceFiles,
  updateJsonIfChanged,
} from '../workspace.ts';

const composePath = 'compose.dev.yml';

interface DbPackage {
  root: string;
  name: string;
}

/**
 * #4792, ADR 0012 decisions 16 and 17: the local Postgres of development. For
 * each db package of the prisma generator (a `prisma.config.ts` that reads
 * CONNECTION_STRING), a repo gets what it does not have: a root
 * compose.dev.yml on port 5432 with the database named after the workspace
 * scope, the `up` and `down` targets, the local CONNECTION_STRING in the env
 * files of the package and of each backend that imports it, and `^up` in the
 * dependsOn of that backend's serve. A compose.dev.yml that is there names the
 * port and the database. A file without the shape that the generator wrote
 * gets no edit, and the log says the step to take by hand.
 */
export default async function addLocalPostgres(tree: Tree): Promise<void> {
  const packages = dbPackages(tree);
  if (packages.length === 0) return;
  const database = localDatabase(tree, packages);
  if (database === undefined) return;
  const connectionString = localConnectionString(database);

  for (const db of packages) {
    updateJsonIfChanged<ProjectManifest>(
      tree,
      joinPathFragments(db.root, 'package.json'),
      (manifest) => {
        manifest.nx = {
          ...manifest.nx,
          targets: addMissingKeys(
            manifest.nx?.targets,
            localDatabaseTargets(offsetFromRoot(db.root), database),
          ),
        };
      },
    );
    addConnectionString(tree, db.root, connectionString);
    for (const backend of backendsOf(tree, db.name)) {
      addUpToServe(tree, backend);
      addConnectionString(tree, backend, connectionString);
    }
  }
  await formatFiles(tree);
}

/** Each db package of the prisma generator. One whose prisma.config.ts reads another variable is left alone. */
function dbPackages(tree: Tree): DbPackage[] {
  const packages: DbPackage[] = [];
  for (const root of projectRootsWith(tree, 'prisma.config.ts')) {
    const config =
      tree.read(joinPathFragments(root, 'prisma.config.ts'), 'utf-8') ?? '';
    const { name } = readJson<ProjectManifest>(
      tree,
      joinPathFragments(root, 'package.json'),
    );
    if (name === undefined) continue;
    if (!config.includes('CONNECTION_STRING')) {
      logger.warn(
        `add-local-postgres: ${root}/prisma.config.ts does not read CONNECTION_STRING, so ${root} is not in the shape of @zukhruf/nx:prisma and got no edit. To take the local Postgres by hand, make prisma.config.ts read CONNECTION_STRING, and add what the prisma generator writes: the up and down targets of ${root}, the local CONNECTION_STRING in its .env.example and .env and in those of each backend that imports ${name}, and "^up" in the dependsOn of that backend's serve (ADR 0012 decisions 16 and 17 of @zukhruf/nx).`,
      );
      continue;
    }
    packages.push({ root, name });
  }
  return packages;
}

/**
 * The database of compose.dev.yml. A missing file is written on port 5432
 * with the database of the workspace scope, as the prisma generator writes it
 * with no port option. A file that is there must have the `database` service
 * that the generator writes, or nothing is changed.
 */
function localDatabase(
  tree: Tree,
  packages: DbPackage[],
): LocalDatabase | undefined {
  const compose = tree.read(composePath, 'utf-8');
  if (compose === null) {
    const database = { port: 5432, name: workspaceScope(tree) };
    tree.write(composePath, composeDevYml(database, packages[0]?.name ?? ''));
    return database;
  }
  const service = /^ {2}database:\n((?: {4,}.*\n|\s*\n)*)/m.exec(compose)?.[1];
  const port =
    service && /['"]?127\.0\.0\.1:(\d+):5432['"]?/.exec(service)?.[1];
  const name =
    service && /^\s+POSTGRES_DB:\s*['"]?([^'"\s]+)/m.exec(service)?.[1];
  const credentials =
    service !== undefined &&
    /^\s+POSTGRES_USER:\s*['"]?postgres['"]?\s*$/m.test(service) &&
    /^\s+POSTGRES_PASSWORD:\s*['"]?postgres['"]?\s*$/m.test(service);
  if (!port || !name || !credentials) {
    logger.warn(
      `add-local-postgres: ${composePath} has no service "database" on 127.0.0.1:<port>:5432 with POSTGRES_USER postgres, POSTGRES_PASSWORD postgres and POSTGRES_DB, so ${packages.map((db) => db.root).join(', ')} got no up, down or CONNECTION_STRING. Give the service that shape, or add the up and down targets and the CONNECTION_STRING of your database by hand (ADR 0012 decisions 16 and 17 of @zukhruf/nx).`,
    );
    return undefined;
  }
  return { port: Number(port), name };
}

/** Each node-app whose source imports the db package, as the prisma generator wires one: `from '<package>'` in its src. */
function backendsOf(tree: Tree, packageName: string): string[] {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const imports = new RegExp(`['"]${escaped}(?:/[^'"]*)?['"]`);
  return projectRootsWith(tree, 'sdk-it.config.ts').filter((root) =>
    sourceFiles(tree, joinPathFragments(root, 'src')).some((path) =>
      imports.test(tree.read(path, 'utf-8') ?? ''),
    ),
  );
}

/** `^up` reaches the db package through the import graph (zukhruf/no-depends-on-project refuses a named project). */
function addUpToServe(tree: Tree, backend: string): void {
  const path = joinPathFragments(backend, 'package.json');
  const serve = readJson<ProjectManifest>(tree, path).nx?.targets?.['serve'];
  if (serve === undefined) {
    logger.warn(
      `add-local-postgres: ${path} has no serve target, so it got no "^up". Add "^up" to the dependsOn of the serve target of ${backend}, so serve starts the local Postgres first.`,
    );
    return;
  }
  updateJsonIfChanged<ProjectManifest>(tree, path, (manifest) => {
    const target = manifest.nx?.targets?.['serve'];
    if (target === undefined) return;
    target.dependsOn = unique([...(target.dependsOn ?? []), '^up']);
  });
}

/**
 * The local URL in `.env.example`, and in `.env` where it is, when the file
 * has no CONNECTION_STRING or has it empty, as the generator wrote it before.
 * A value that is there stays.
 */
function addConnectionString(
  tree: Tree,
  root: string,
  connectionString: string,
): void {
  for (const file of ['.env.example', '.env']) {
    const path = joinPathFragments(root, file);
    const content = tree.read(path, 'utf-8');
    if (content === null) continue;
    if (envValue(content, 'CONNECTION_STRING') === '') {
      tree.write(
        path,
        content.replace(
          /^CONNECTION_STRING=$/m,
          `CONNECTION_STRING=${connectionString}`,
        ),
      );
    } else {
      addEnvEntry(tree, path, 'CONNECTION_STRING', connectionString);
    }
  }
}
