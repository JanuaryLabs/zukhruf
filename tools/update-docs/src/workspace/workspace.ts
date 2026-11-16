import { glob, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { UnknownProject } from '../errors.ts';
import { Project } from './project.ts';

/** The Nx projects of the workspace whose root is under packages/. */
export class Workspace {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async projects(): Promise<Project[]> {
    const projects: Project[] = [];
    for await (const file of glob('packages/**/project.json', {
      cwd: this.#root,
      exclude: ['**/node_modules/**'],
    })) {
      const root = dirname(file).replaceAll('\\', '/');
      const { name } = await this.#manifest(join(root, 'project.json'));
      const { name: npmName } = await this.#manifest(
        join(root, 'package.json'),
      );
      projects.push(new Project(name, npmName, root));
    }
    return projects.toSorted((a, b) => a.name.localeCompare(b.name));
  }

  async project(name: string): Promise<Project> {
    const projects = await this.projects();
    const found = projects.find((project) => project.name === name);
    if (found === undefined) {
      throw new UnknownProject(
        name,
        projects.map((project) => project.name),
      );
    }
    return found;
  }

  async #manifest(file: string): Promise<{ name: string }> {
    const value: unknown = JSON.parse(
      await readFile(join(this.#root, file), 'utf8'),
    );
    if (
      typeof value === 'object' &&
      value !== null &&
      'name' in value &&
      typeof value.name === 'string'
    ) {
      return { name: value.name };
    }
    throw new TypeError(`${file} has no "name" string`);
  }
}
