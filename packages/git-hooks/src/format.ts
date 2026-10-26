import { join } from 'node:path';

import { check, getFileInfo, resolveConfig } from 'prettier';

import type { Commit } from './commit.ts';
import { type Outcome, Step } from './step.ts';

// Checks the staged copy of each staged file with the repo's Prettier config,
// and changes nothing. A step that formatted and staged files would also stage
// the edits that another session made to them at the same moment.
export class Format extends Step<Commit> {
  readonly name = 'format';

  async run(commit: Commit): Promise<Outcome> {
    const unformatted: { path: string; reason?: string }[] = [];
    const ignorePath = join(commit.root, '.prettierignore');
    for (const path of await commit.files()) {
      const file = join(commit.root, path);
      // Prettier gives no parser for a file that .prettierignore names or that
      // it cannot format, so no list of extensions here.
      const { inferredParser } = await getFileInfo(file, { ignorePath });
      if (inferredParser === null) continue;
      const options = await resolveConfig(file);
      try {
        const source = await commit.blob(path);
        const formatted = await check(source, { ...options, filepath: file });
        if (!formatted) unformatted.push({ path });
      } catch (error) {
        const [reason = ''] = String(error).split('\n');
        unformatted.push({ path, reason });
      }
    }
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
