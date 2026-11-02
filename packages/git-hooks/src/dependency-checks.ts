import { join, posix } from 'node:path';

import type { Commit } from './commit.ts';
import { type Outcome, Step } from './step.ts';

// The package.json of the project that holds `path`: the nearest one up the
// folders that the commit has, found by asking the index for each candidate.
async function manifestOf(
  commit: Commit,
  path: string,
  found: Map<string, string | null>,
): Promise<string | null> {
  let folder = posix.dirname(path);
  const visited: string[] = [];
  for (;;) {
    const known = found.get(folder);
    if (known !== undefined) {
      for (const each of visited) found.set(each, known);
      return known;
    }
    visited.push(folder);
    const candidate =
      folder === '.' ? 'package.json' : `${folder}/package.json`;
    const exists = await commit.blob(candidate).then(
      () => true,
      () => false,
    );
    if (exists) {
      for (const each of visited) found.set(each, candidate);
      return candidate;
    }
    if (folder === '.') {
      for (const each of visited) found.set(each, null);
      return null;
    }
    folder = posix.dirname(folder);
  }
}

// Lints the staged package.json of each project that the commit touches, with
// the repo's own ESLint config, and changes nothing. A dependency rule such as
// dependency-checks reports on package.json, so linting only the staged source
// files never runs it; the commit stops here instead of CI after a push.
export class DependencyChecks extends Step<Commit> {
  readonly name = 'dependencies';

  async run(commit: Commit): Promise<Outcome> {
    const found = new Map<string, string | null>();
    const manifests = new Set<string>();
    for (const path of await commit.staged()) {
      const manifest = await manifestOf(commit, path, found);
      if (manifest !== null) manifests.add(manifest);
    }
    if (manifests.size === 0) return this.skip('no project is touched');

    const { ESLint } = await import('eslint');
    const eslint = new ESLint({ cwd: commit.root });
    const problems: string[] = [];
    const failing = new Set<string>();
    for (const manifest of [...manifests].sort()) {
      const filePath = join(commit.root, manifest);
      if (await eslint.isPathIgnored(filePath)) continue;
      const results = await eslint.lintText(await commit.blob(manifest), {
        filePath,
      });
      for (const { messages } of results)
        for (const message of messages)
          if (message.severity === 2) {
            failing.add(manifest);
            problems.push(
              `${manifest}:${message.line}  ${message.message}${message.ruleId === null ? '' : `  ${message.ruleId}`}`,
            );
          }
    }
    if (problems.length === 0)
      return this.pass(
        `the package.json of ${manifests.size} touched project${manifests.size === 1 ? '' : 's'} lints clean`,
      );
    return this.fail(
      [
        'The package.json of a touched project breaks the lint:',
        ...problems.map((problem) => `  ${problem}`),
        `Run \`npx eslint ${[...failing].join(' ')}\`, fix ${failing.size === 1 ? 'it' : 'them'}, stage ${failing.size === 1 ? 'it' : 'them'}, and commit again.`,
      ].join('\n'),
    );
  }
}
