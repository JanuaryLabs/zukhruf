import { relative, sep } from 'node:path';

import type { Commit } from './commit.ts';
import { type Outcome, Step } from './step.ts';
import { matches } from './tree.ts';

const WORKFLOWS = ['.github/**/*.yml', '.github/**/*.yaml'];

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

// Lints each staged workflow and action under .github, with the commit's own
// ESLint and config in the snapshot of the staged commit, and changes
// nothing. No project holds .github, so a lint of the projects never reads
// these files; the commit stops here instead of CI after a push.
export class WorkflowChecks extends Step<Commit> {
  readonly name = 'workflows';

  async run(commit: Commit): Promise<Outcome> {
    const staged = (await commit.changes())
      .filter(
        (entry) =>
          entry.change !== 'deleted' &&
          entry.kind === 'file' &&
          matches(entry.path, WORKFLOWS),
      )
      .map(({ path }) => path)
      .sort();
    if (staged.length === 0) return this.skip('no workflow is staged');

    const snapshot = await commit.snapshot({ packages: true });
    const { status, stdout, stderr } = await snapshot.bin('eslint', [
      '--format',
      'json',
      '--no-warn-ignored',
      '--',
      ...staged,
    ]);
    // ESLint exits with 2 when it cannot run, such as a broken config.
    if (status === 2 || status === null)
      return this.fail(
        `eslint could not lint ${staged.join(', ')}:\n${stderr.trimEnd()}`,
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
      const workflow = relative(snapshot.folder, filePath).split(sep).join('/');
      for (const message of messages)
        if (message.severity === 2) {
          failing.add(workflow);
          problems.push(
            `${workflow}:${message.line ?? 0}  ${message.message}${message.ruleId === null ? '' : `  ${message.ruleId}`}`,
          );
        }
    }
    if (problems.length === 0)
      return this.pass(
        `${staged.length} staged workflow${staged.length === 1 ? '' : 's'} lint${staged.length === 1 ? 's' : ''} clean`,
      );
    const pronoun = failing.size === 1 ? 'it' : 'them';
    return this.fail(
      [
        'A staged workflow breaks the lint:',
        ...problems.map((problem) => `  ${problem}`),
        `Run \`npx eslint ${[...failing].join(' ')}\`, fix ${pronoun}, stage ${pronoun}, and commit again.`,
      ].join('\n'),
    );
  }
}
