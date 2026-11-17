import type { CommitMessage } from './commit-message.ts';
import type { Commit } from './commit.ts';
import type { Push } from './push.ts';
import { withoutRepoVariables } from './repo-variables.ts';
import { runCommitMsg } from './run/commit-msg.ts';
import { runPreCommit } from './run/pre-commit.ts';
import { runPrePush } from './run/pre-push.ts';
import type { Outcome, Step } from './step.ts';

// Each function runs steps as its hook runs them, on the repo at `root`, and
// gives the outcome of each step that ran, so a repo tests its own steps
// through the real loop. `environment` stands for the hook environment.

// Runs pre-commit steps on the staged commit. When the hook would stop the
// commit after the steps, such as when the index changed while they ran, the
// last outcome is that fail.
export async function preCommit(
  { root, environment }: { root: string; environment: NodeJS.ProcessEnv },
  steps: readonly Step<Commit>[],
): Promise<readonly Outcome[]> {
  const result = await runPreCommit(
    {
      root,
      hookEnvironment: environment,
      toolEnvironment: await withoutRepoVariables(environment),
      print: () => {},
    },
    steps,
  );
  return result.kind === 'stopped'
    ? [...result.outcomes, { kind: 'fail', message: result.reason }]
    : result.outcomes;
}

// Runs pre-push steps on a push to `remote`. `input` holds the lines that git
// gives the hook on its standard input: `<local ref> <local sha> <remote ref>
// <remote sha>` for each ref update.
export async function prePush(
  {
    root,
    environment,
    remote,
    input,
  }: {
    root: string;
    environment: NodeJS.ProcessEnv;
    remote: { name: string; url: string };
    input: string;
  },
  steps: readonly Step<Push>[],
): Promise<readonly Outcome[]> {
  const { outcomes } = await runPrePush(
    {
      root,
      hookEnvironment: environment,
      toolEnvironment: await withoutRepoVariables(environment),
      print: () => {},
      remote,
      input,
    },
    steps,
  );
  return outcomes;
}

// Runs commit-msg steps on the message in `file`.
export async function commitMsg(
  {
    root,
    environment,
    file,
  }: { root: string; environment: NodeJS.ProcessEnv; file: string },
  steps: readonly Step<CommitMessage>[],
): Promise<readonly Outcome[]> {
  const { outcomes } = await runCommitMsg(
    { root, hookEnvironment: environment, print: () => {}, file },
    steps,
  );
  return outcomes;
}
