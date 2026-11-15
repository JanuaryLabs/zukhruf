import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { promisify } from 'node:util';

import { type Commit, type Outcome, Step } from '@zukhruf/git-hooks';

const execFileAsync = promisify(execFile);

// Each workspace package has a row in the Packages table of the root README,
// in the form [`<name>`](./<folder>). Nine packages drifted out of the table
// before a step checked it (#4436). The step reads the staged copies only, so
// a package of another session that is on disk but not staged never stops
// this commit. It runs when a commit stages a package.json or the README, and
// checks every package, so a row that a commit deletes is caught too.
export class ReadmeRows extends Step<Commit> {
  readonly name = 'readme';

  async run(commit: Commit): Promise<Outcome> {
    const staged = await commit.files();
    if (
      !staged.some(
        (path) =>
          path === 'README.md' || posix.basename(path) === 'package.json',
      )
    )
      return this.skip('no staged package.json or README');
    const readme = await commit.blob('README.md');
    const missing: string[] = [];
    for (const manifest of await this.#manifests(commit)) {
      const row = `[\`${packageName(await commit.blob(manifest))}\`](./${posix.dirname(manifest)})`;
      if (!readme.includes(row)) missing.push(row);
    }
    if (missing.length === 0)
      return this.pass('each package has its row in the root README');
    return this.fail(
      [
        'The Packages table of the root README has no row for:',
        ...missing.map((row) => `  ${row}`),
        'Add one row each, with what the package does, and stage README.md.',
      ].join('\n'),
    );
  }

  // The staged package.json of each workspace package. The workspaces of the
  // root package.json say where packages live; apps have a table of their own.
  async #manifests(commit: Commit): Promise<string[]> {
    const pathspecs = workspaces(await commit.blob('package.json'))
      .filter((glob) => glob.startsWith('packages/'))
      .map((glob) => `:(glob)${glob}/package.json`);
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--', ...pathspecs],
      { cwd: commit.root },
    );
    return stdout.split('\0').filter((path) => path !== '');
  }
}

function packageName(source: string): string {
  const manifest: unknown = JSON.parse(source);
  if (
    typeof manifest === 'object' &&
    manifest !== null &&
    'name' in manifest &&
    typeof manifest.name === 'string'
  )
    return manifest.name;
  throw new Error(`a workspace package.json has no name:\n${source}`);
}

function workspaces(source: string): string[] {
  const manifest: unknown = JSON.parse(source);
  if (
    typeof manifest === 'object' &&
    manifest !== null &&
    'workspaces' in manifest &&
    Array.isArray(manifest.workspaces)
  )
    return manifest.workspaces.filter(
      (glob): glob is string => typeof glob === 'string',
    );
  throw new Error('the root package.json has no workspaces array');
}
