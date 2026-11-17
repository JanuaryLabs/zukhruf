import { join, posix } from 'node:path';

import { type Commit, type Outcome, Step } from '@zukhruf/git-hooks';

import { STALE, generatedReadme } from './packages-table.ts';

// The Packages table of the root README comes from the package.json
// description of each workspace package (tools/readme-table). When a commit
// changes a package.json or the README, a deletion included, the step checks
// the README of the staged tree against the table that the staged manifests
// give, with the commit's Prettier config.
export class ReadmeTable extends Step<Commit> {
  readonly name = 'readme';

  async run(commit: Commit): Promise<Outcome> {
    if (
      !(await commit.changes()).some(
        ({ path }) =>
          path === 'README.md' || posix.basename(path) === 'package.json',
      )
    )
      return this.skip('no staged package.json or README');
    const tree = await commit.tree();
    const readme = (await tree.read('README.md')) ?? '';
    const snapshot = await commit.snapshot({ packages: true });
    const generated = await generatedReadme(
      tree,
      readme,
      join(snapshot.folder, 'README.md'),
    );
    if (generated === readme)
      return this.pass('the Packages table is the one the descriptions give');
    return this.fail(STALE);
  }
}
