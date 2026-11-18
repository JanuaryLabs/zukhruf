import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface Trailer {
  readonly key: string;
  readonly value: string;
}

// The message of the commit that git is about to make, as the commit-msg hook
// gets it in a file. Git gives the hook the text before its cleanup, so the
// comment lines of the editor are still in it; the text here has none.
export class CommitMessage {
  readonly text: string;
  // The subject as `git log --format=%s` gives it, and as nx release reads
  // it: the first paragraph, with its lines joined by spaces.
  readonly subject: string;
  // The trailers as git reads them, in their order, with their keys as
  // written: a folded value is on one line.
  readonly trailers: readonly Trailer[];

  private constructor(text: string, trailers: readonly Trailer[]) {
    this.text = text;
    this.subject = (text.split('\n\n')[0] ?? '').split('\n').join(' ');
    this.trailers = trailers;
  }

  static async read(
    root: string,
    environment: NodeJS.ProcessEnv,
    file: string,
  ): Promise<CommitMessage> {
    const git = (args: readonly string[], input: string) => {
      const run = execFileAsync('git', args, {
        cwd: root,
        env: environment,
        encoding: 'utf8',
      });
      run.child.stdin?.end(input);
      return run;
    };
    const { stdout: text } = await git(
      ['stripspace', '--strip-comments'],
      await readFile(file, 'utf8'),
    );
    // `--parse` prints each trailer as `key: value`. The input is a commit
    // message, not a patch, so `--no-divider`: a "---" line of the body does
    // not end the message.
    const { stdout: trailers } = await git(
      ['interpret-trailers', '--parse', '--no-divider'],
      text,
    );
    return new CommitMessage(
      text,
      trailers
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => {
          const separator = line.indexOf(': ');
          return {
            key: line.slice(0, separator),
            value: line.slice(separator + 2),
          };
        }),
    );
  }
}
