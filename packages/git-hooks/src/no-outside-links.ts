import { posix } from 'node:path';

import type { Commit } from './commit.ts';
import { installedOutsideLinks } from './npm/installed-links.ts';
import { Lockfile } from './npm/lockfile.ts';
import { type Outcome, Step } from './step.ts';

export interface NoOutsideLinksOptions {
  // Globs of the package names that may link to another checkout, such as
  // `@eltjs/*`.
  readonly allowed?: readonly string[];
}

// Stops a commit while the repo uses a package from another checkout: the
// staged package-lock.json links a folder outside the repo (`npm link`), or
// an installed package in node_modules of the root or of a workspace is a
// link whose real path is outside the repo. The repo then runs code that no
// release holds. A workspace link points inside the repo, and passes.
export class NoOutsideLinks extends Step<Commit> {
  readonly name = 'outside-links';
  readonly #allowed: readonly string[];

  constructor({ allowed = [] }: NoOutsideLinksOptions = {}) {
    super();
    this.#allowed = allowed;
  }

  async run(commit: Commit): Promise<Outcome> {
    const problems: string[] = [];
    const text = await (await commit.tree()).read('package-lock.json');
    if (text !== undefined)
      for (const { name, target } of Lockfile.parse(text).outsideLinks())
        if (!this.#isAllowed(name))
          problems.push(`package-lock.json  ${name} -> ${target}`);
    for (const { folder, name, target } of await installedOutsideLinks(
      commit.installRoot,
    ))
      if (!this.#isAllowed(name)) problems.push(`${folder} -> ${target}`);
    if (problems.length === 0) return this.pass('no links outside the repo');
    return this.fail(
      [
        'The repo uses a package from another checkout:',
        ...problems.map((problem) => `  ${problem}`),
        'push the package (a push to its main releases it), then npm install the published version.',
      ].join('\n'),
    );
  }

  #isAllowed(name: string): boolean {
    return this.#allowed.some((glob) => posix.matchesGlob(name, glob));
  }
}
