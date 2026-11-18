import type { CommitMessage } from './commit-message.ts';
import { type Outcome, Step } from './step.ts';

// The keys of the attribution trailers, in lower case: git reads trailer keys
// without case.
const ATTRIBUTION = new Set(['co-authored-by', 'claude-session']);

// Stops a commit whose message ends with an attribution trailer:
// `Co-authored-by` or `Claude-Session`. The step reads the trailers as git
// does, so a line of the same form in the middle of the body passes.
export class NoAttributionTrailer extends Step<CommitMessage> {
  readonly name = 'trailer';

  async run(message: CommitMessage): Promise<Outcome> {
    const found = message.trailers.filter(({ key }) =>
      ATTRIBUTION.has(key.toLowerCase()),
    );
    if (found.length === 0) return this.pass('no attribution trailer');
    return this.fail(
      [
        'This message ends with attribution trailers, which this repo keeps',
        'out of its commits:',
        ...found.map(({ key, value }) => `  ${key}: ${value}`),
        'Remove these lines from the message.',
      ].join('\n'),
    );
  }
}
