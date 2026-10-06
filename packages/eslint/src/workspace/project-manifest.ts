import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { isRecord, stringsAt } from '../authoring/ast.ts';

export interface Project {
  /** Absolute folder that holds the project's project.json or package.json. */
  readonly root: string;
  /** Tags from project.json `tags` and package.json `nx.tags`. */
  readonly tags: readonly string[];
}

const projectByDirectory = new Map<string, Project | undefined>();

function readJson(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

function projectAt(directory: string): Project | undefined {
  const projectJson = join(directory, 'project.json');
  const packageJson = join(directory, 'package.json');
  if (!existsSync(projectJson) && !existsSync(packageJson)) return undefined;
  const packageManifest = readJson(packageJson);
  const nx = isRecord(packageManifest) ? packageManifest['nx'] : undefined;
  return {
    root: directory,
    tags: [
      ...stringsAt(readJson(projectJson), 'tags'),
      ...stringsAt(nx, 'tags'),
    ],
  };
}

function findProject(directory: string): Project | undefined {
  const project = projectAt(directory);
  if (project) return project;
  const parent = dirname(directory);
  return parent === directory ? undefined : projectOfDirectory(parent);
}

function projectOfDirectory(directory: string): Project | undefined {
  if (!projectByDirectory.has(directory)) {
    projectByDirectory.set(directory, findProject(directory));
  }
  return projectByDirectory.get(directory);
}

/**
 * The project that holds `filename`, as Nx defines one: the nearest folder with
 * a project.json or a package.json. Its tags are read from those manifests
 * rather than from Nx's cached project graph, which does not exist on a fresh
 * clone, so tags that an Nx plugin infers are not seen.
 */
export function projectOf(filename: string): Project | undefined {
  return projectOfDirectory(dirname(resolve(filename)));
}
