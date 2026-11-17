import { posix, relative, sep } from 'node:path';

import type { Commit } from './commit.ts';
import { type Outcome, Step } from './step.ts';

// The package.json of the project that holds `path`: the nearest one up its
// folders among the manifests of the staged tree.
function manifestOf(
  path: string,
  manifests: ReadonlySet<string>,
): string | null {
  let folder = posix.dirname(path);
  for (;;) {
    const candidate =
      folder === '.' ? 'package.json' : `${folder}/package.json`;
    if (manifests.has(candidate)) return candidate;
    if (folder === '.') return null;
    folder = posix.dirname(folder);
  }
}

// One result of `eslint --format json`.
interface LintResult {
  readonly filePath: string;
  readonly messages: readonly {
    readonly severity: number;
    readonly line?: number;
    readonly message: string;
    readonly ruleId: string | null;
  }[];
}

function isLintResults(value: unknown): value is readonly LintResult[] {
  return (
    Array.isArray(value) &&
    value.every(
      (result) =>
        typeof result === 'object' &&
        result !== null &&
        'filePath' in result &&
        'messages' in result &&
        Array.isArray(result.messages),
    )
  );
}

// Lints the staged package.json of each project that the commit touches, a
// deletion included, with the commit's own ESLint and config in the snapshot
// of the staged commit, and changes nothing. A dependency rule such as
// dependency-checks reports on package.json, so linting only the staged
// source files never runs it; the commit stops here instead of CI after a
// push.
export class DependencyChecks extends Step<Commit> {
  readonly name = 'dependencies';

  async run(commit: Commit): Promise<Outcome> {
    const tree = await commit.tree();
    const all = new Set(
      tree.entries(['**/package.json']).map(({ path }) => path),
    );
    const manifests = new Set<string>();
    for (const { path } of await commit.changes()) {
      const manifest = manifestOf(path, all);
      if (manifest !== null) manifests.add(manifest);
    }
    if (manifests.size === 0) return this.skip('no project is touched');

    const snapshot = await commit.snapshot({ packages: true });
    const sorted = [...manifests].sort();
    const { status, stdout, stderr } = await snapshot.bin('eslint', [
      '--format',
      'json',
      '--no-warn-ignored',
      '--',
      ...sorted,
    ]);
    // ESLint exits with 2 when it cannot run, such as a broken config.
    if (status === 2 || status === null)
      return this.fail(
        `eslint could not lint ${sorted.join(', ')}:\n${stderr.trimEnd()}`,
      );
    const results: unknown = JSON.parse(stdout);
    if (!isLintResults(results))
      throw new TypeError(
        `eslint gave ${stdout.slice(0, 200)}, not lint results`,
      );
    const problems: string[] = [];
    const failing = new Set<string>();
    for (const { filePath, messages } of results) {
      // ESLint gives a path of the platform: on Windows, with backslashes.
      const manifest = relative(snapshot.folder, filePath).split(sep).join('/');
      for (const message of messages)
        if (message.severity === 2) {
          failing.add(manifest);
          problems.push(
            `${manifest}:${message.line ?? 0}  ${message.message}${message.ruleId === null ? '' : `  ${message.ruleId}`}`,
          );
        }
    }
    if (problems.length === 0)
      return this.pass(
        `the package.json of ${manifests.size} touched project${manifests.size === 1 ? '' : 's'} lints clean`,
      );
    const pronoun = failing.size === 1 ? 'it' : 'them';
    return this.fail(
      [
        'The package.json of a touched project breaks the lint:',
        ...problems.map((problem) => `  ${problem}`),
        `Run \`npx eslint ${[...failing].join(' ')}\`, fix ${pronoun}, stage ${pronoun}, and commit again.`,
      ].join('\n'),
    );
  }
}
