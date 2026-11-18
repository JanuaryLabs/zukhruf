import type { CommitMessage } from './commit-message.ts';
import { type Outcome, Step } from './step.ts';

// Stops a commit that nx release reads as a breaking change (Conventional
// Commits 1.0.0), which it turns into a major version. The step asks the
// repo's own nx, so it judges the message as `nx release` of the repo does: a
// `!` before the ": " of the header, and `BREAKING CHANGE:` anywhere in the
// body. nx 23 does not read `BREAKING-CHANGE:`, the synonym of the spec, and
// makes no major version for it, so the step passes it.
export class NoBreakingChange extends Step<CommitMessage> {
  readonly name = 'breaking';

  async run(message: CommitMessage): Promise<Outcome> {
    const { parseGitCommit } =
      await import('nx/src/command-line/release/utils/git.js');
    // The body as nx gets it from `git log --format=%b`: the message after
    // its first paragraph.
    const commit = parseGitCommit({
      message: message.subject,
      body: message.text.split('\n\n').slice(1).join('\n\n'),
      shortHash: '',
      author: { name: '', email: '' },
    });
    if (commit?.isBreaking !== true) return this.pass('no breaking change');
    return this.fail(
      [
        'nx release reads this message as a breaking change and makes a major',
        'version of it. This repo ships no breaking changes.',
        'Remove the "!" before the ": " of the subject, and "BREAKING CHANGE:"',
        'from the body.',
      ].join('\n'),
    );
  }
}
