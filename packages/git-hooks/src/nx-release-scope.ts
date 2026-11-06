import type { CommitMessage } from './commit-message.ts';
import { type Outcome, Step } from './step.ts';

// A conventional-commit header whose scope is its first parenthesis: the
// scope holds no parenthesis.
const HEADER =
  /^(?<type>[^\s():!]+)(?:\s*\((?<scope>[^()]*)\))?(?<breaking>!)?: (?<description>.+)$/u;

// Stops a commit whose subject nx release reads with another scope than its
// first parenthesis. The parser of nx takes the scope up to the last "): " of
// the subject, so `fix(a): b (c, #1): d` gets the scope `a): b (c, #1`, and a
// `!` before the first ": " is lost. The step asks the repo's own nx, so it
// judges the subject as the nx release of the repo will.
export class NxReleaseScope extends Step<CommitMessage> {
  readonly name = 'scope';

  async run(message: CommitMessage): Promise<Outcome> {
    const { parseConventionalCommitsMessage } =
      await import('nx/src/command-line/release/utils/git');
    // nx gives the type __INVALID__ to a subject that is no conventional
    // header, such as that of a merge commit.
    const nx = parseConventionalCommitsMessage(message.subject) ?? {
      type: '__INVALID__',
      scope: '',
      breaking: false,
    };
    const header = HEADER.exec(message.subject)?.groups;
    const scope = header?.['scope'] ?? '';
    const breaking = header?.['breaking'] !== undefined;
    if (
      nx.type === (header?.['type'] ?? '__INVALID__') &&
      nx.scope === scope &&
      nx.breaking === breaking
    )
      return this.pass();
    return this.fail(
      [
        `nx release reads the scope of this subject as ${JSON.stringify(nx.scope)}${header === undefined ? '' : `, not ${JSON.stringify(scope)}`}:`,
        '  its parser takes the scope up to the last "): " of the subject.',
        ...(breaking && !nx.breaking
          ? ['  It also loses the "!", so a breaking change ships as a patch.']
          : []),
        'A scope that names no project gives the commit to no project, and a',
        'scope piece that starts with "#" stops `nx release version`.',
        'Write "; " after a parenthesis in the subject, as "(#3840); ", or move',
        'the parenthesis to the body.',
      ].join('\n'),
    );
  }
}
