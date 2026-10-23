import { join } from 'node:path';

import { check, getFileInfo, resolveConfig } from 'prettier';

import type { Commit } from './commit.ts';
import { type Outcome, Step } from './step.ts';

// Checks the staged copy of each staged file with the repo's Prettier config,
// and changes nothing. A step that formatted and staged files would also stage
// the edits that another session made to them at the same moment.
export class Format extends Step {
  readonly name = 'format';

  async run(commit: Commit): Promise<Outcome> {
    const unformatted: string[] = [];
    const ignorePath = join(commit.root, '.prettierignore');
    for (const path of await commit.staged()) {
      const file = join(commit.root, path);
      // Prettier gives no parser for a file that .prettierignore names or that
      // it cannot format, so no list of extensions here.
      const { inferredParser } = await getFileInfo(file, { ignorePath });
      if (inferredParser === null) continue;
      const options = await resolveConfig(file);
      try {
        const source = await commit.blob(path);
        const formatted = await check(source, { ...options, filepath: file });
        if (!formatted) unformatted.push(path);
      } catch (error) {
        unformatted.push(`${path} (${String(error).split('\n')[0]})`);
      }
    }
    if (unformatted.length === 0)
      return this.pass('the staged files are formatted');
    return this.fail(
      [
        `${unformatted.length} staged files are not formatted:`,
        ...unformatted.map((path) => `  ${path}`),
        `Run \`npx prettier --write ${unformatted.join(' ')}\`, stage them, and commit again.`,
      ].join('\n'),
    );
  }
}
