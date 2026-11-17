import type { Commit } from './commit.ts';
import {
  DEPENDENCY_SECTIONS,
  Lockfile,
  dependencySpecs,
} from './npm/lockfile.ts';
import { type Outcome, Step } from './step.ts';
import type { Tree } from './tree.ts';

// Stops a commit whose package-lock.json does not record its package.json
// files, so the commit installs with `npm ci` as CI and each image install
// it. Two checks, each for what the other misses:
// - each dependency of a staged package.json has the spec that the lockfile
//   recorded for that project. `npm ci` accepts a range edit that the locked
//   version still satisfies, so the lockfile keeps the old range.
// - `npm ci --dry-run` in the snapshot of the staged commit: npm's own check
//   that the lockfile holds each dependency of each package.json.
export class LockfileSync extends Step<Commit> {
  readonly name = 'lockfile';

  async run(commit: Commit): Promise<Outcome> {
    if (
      !(await commit.touches([
        '**/package.json',
        'package-lock.json',
        '.npmrc',
      ]))
    )
      return this.skip('no package.json, package-lock.json or .npmrc');
    const tree = await commit.tree();
    if ((await tree.read('package.json')) === undefined)
      return this.skip('the commit has no package.json');
    const text = await tree.read('package-lock.json');
    if (text === undefined)
      return this.fail(
        'the commit has a package.json but no package-lock.json. Run `npm install`, stage package-lock.json, and commit again.',
      );
    const differences = await this.#differences(Lockfile.parse(text), tree);
    if (differences.length > 0)
      return this.fail(
        [
          'package-lock.json records other specs than the staged package.json files:',
          ...differences.map((difference) => `  ${difference}`),
          'Run `npm install`, stage package-lock.json, and commit again.',
        ].join('\n'),
      );
    const snapshot = await commit.snapshot();
    const { status, stderr } = await snapshot.run('npm', [
      'ci',
      '--dry-run',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
    ]);
    if (status !== 0)
      return this.fail(
        `npm ci does not accept the staged package-lock.json:\n${stderr.trimEnd()}\nRun \`npm install\`, stage package-lock.json, and commit again.`,
      );
    return this.pass('package-lock.json records each staged package.json');
  }

  // Each dependency whose spec in a staged package.json differs from the spec
  // that the lockfile recorded for its project. A project of the lockfile
  // whose package.json is not in the commit is left to npm ci.
  async #differences(lockfile: Lockfile, tree: Tree): Promise<string[]> {
    const differences: string[] = [];
    for (const project of lockfile.projects()) {
      const path = project === '' ? 'package.json' : `${project}/package.json`;
      const manifest = await tree.read(path);
      const recorded = lockfile.specs(project);
      if (manifest === undefined || recorded === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(manifest);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        differences.push(`${path}  is not JSON: ${error.message}`);
        continue;
      }
      const staged = dependencySpecs(parsed);
      for (const section of DEPENDENCY_SECTIONS) {
        const inManifest = staged[section];
        const inLockfile = recorded[section];
        for (const name of new Set([
          ...inManifest.keys(),
          ...inLockfile.keys(),
        ]))
          if (inManifest.get(name) !== inLockfile.get(name))
            differences.push(
              `${path}  ${section}.${name}: ${inManifest.get(name) ?? 'absent'} in package.json, ${inLockfile.get(name) ?? 'absent'} in package-lock.json`,
            );
      }
    }
    return differences;
  }
}
