import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// The message of the commit that git is about to make, as the commit-msg hook
// gets it in a file. Git gives the hook the text before its cleanup, so the
// comment lines of the editor are still in it; the text here has none.
export class CommitMessage {
  readonly text: string;
  // The subject as `git log --format=%s` gives it, and as nx release reads
  // it: the first paragraph, with its lines joined by spaces.
  readonly subject: string;

  private constructor(text: string) {
    this.text = text;
    this.subject = (text.split('\n\n')[0] ?? '').split('\n').join(' ');
  }

  static async read(
    root: string,
    environment: NodeJS.ProcessEnv,
    file: string,
  ): Promise<CommitMessage> {
    const git = execFileAsync('git', ['stripspace', '--strip-comments'], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
    });
    git.child.stdin?.end(await readFile(file, 'utf8'));
    return new CommitMessage((await git).stdout);
  }
}
