import { posix } from 'node:path';

import { type Commit, type Outcome, Step } from '@zukhruf/git-hooks';

import {
  STALE,
  generatedReadme,
} from '../tools/readme-table/src/packages-table.ts';

// The Packages table of the root README comes from the package.json
// description of each workspace package (tools/readme-table). When a commit
// stages a package.json or the README, the step runs the CI check on the
// staged copies. It runs in the hook's process, not through Commit.nx: nx
// gets no GIT_INDEX_FILE, so a check through nx would read the index of the
// working tree instead of the commit's.
export class ReadmeTable extends Step<Commit> {
  readonly name = 'readme';

  async run(commit: Commit): Promise<Outcome> {
    if (
      !(await commit.files()).some(
        (path) =>
          path === 'README.md' || posix.basename(path) === 'package.json',
      )
    )
      return this.skip('no staged package.json or README');
    const readme = await commit.blob('README.md');
    if ((await generatedReadme(commit.root, readme)) === readme)
      return this.pass('the Packages table is the one the descriptions give');
    return this.fail(STALE);
  }
}
