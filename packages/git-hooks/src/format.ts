import type { Commit } from './commit.ts';
import { type Outcome, Step } from './step.ts';

// Checks the staged copy of each staged file with the commit's own Prettier,
// config and .prettierignore, in the snapshot of the staged commit, and
// changes nothing. A step that formatted and staged files would also stage
// the edits that another session made to them at the same moment.
export class Format extends Step<Commit> {
  readonly name = 'format';

  async run(commit: Commit): Promise<Outcome> {
    // The staged copy of a link or a submodule is a path or a commit id, so
    // only files are checked.
    const files = (await commit.changes()).flatMap((entry) =>
      entry.change !== 'deleted' && entry.kind === 'file' ? [entry.path] : [],
    );
    if (files.length === 0) return this.pass('no staged file to check');
    const snapshot = await commit.snapshot({ packages: true });
    // --ignore-unknown skips a file that .prettierignore names or that
    // Prettier cannot format, so no list of extensions here.
    const { stdout, stderr } = await snapshot.bin('prettier', [
      '--list-different',
      '--ignore-unknown',
      '--',
      ...files,
    ]);
    // Prettier prints `[error] <path>: <reason>` for a file it cannot parse,
    // and then the code frame on more [error] lines. A reason is read only
    // by the path of a checked file, so a code frame line names no file.
    const reasons = new Map<string, string>();
    for (const line of stderr.split('\n')) {
      const [, path, reason] = /^\[error\] (.+?): (.+)$/.exec(line) ?? [];
      if (path !== undefined && reason !== undefined) reasons.set(path, reason);
    }
    const different = new Set(stdout.split('\n'));
    // In the order of the staged files, as the command at the end lists them.
    const unformatted = files.flatMap(
      (path): { path: string; reason?: string }[] => {
        const reason = reasons.get(path);
        if (reason !== undefined) return [{ path, reason }];
        return different.has(path) ? [{ path }] : [];
      },
    );
    if (unformatted.length === 0)
      return this.pass('the staged files are formatted');
    const paths = unformatted.map(({ path }) => path);
    const one = unformatted.length === 1;
    return this.fail(
      [
        one
          ? '1 staged file is not formatted:'
          : `${unformatted.length} staged files are not formatted:`,
        ...unformatted.map(({ path, reason }) =>
          reason === undefined ? `  ${path}` : `  ${path} (${reason})`,
        ),
        `Run \`npx prettier --write ${paths.join(' ')}\`, stage ${one ? 'it' : 'them'}, and commit again.`,
      ].join('\n'),
    );
  }
}
