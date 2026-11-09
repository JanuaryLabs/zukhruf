import { glob, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The copy ledgers of a workspace. One line of a ledger is one record: a table
 * row, a `Places:` line or an `a → b` line. A line records a copy when it names
 * both files, so a ledger that names two files for two other copies records
 * nothing between them.
 */
export class CopyLedgers {
  readonly #records: readonly (readonly string[])[];

  private constructor(records: readonly (readonly string[])[]) {
    this.#records = records;
  }

  static async read(workspace: string): Promise<CopyLedgers> {
    const records: string[][] = [];
    for await (const ledger of glob('**/docs/copied-*.md', {
      cwd: workspace,
      exclude: (name) => name === 'node_modules',
    })) {
      const text = await readFile(join(workspace, ledger), 'utf8');
      for (const line of text.split('\n')) {
        records.push(
          Array.from(line.matchAll(/`([^`]+)`/g), ([, span]) => span ?? ''),
        );
      }
    }
    return new CopyLedgers(records);
  }

  records(first: string, second: string): boolean {
    return this.#records.some(
      (names) =>
        names.some((name) => this.#names(name, first)) &&
        names.some((name) => this.#names(name, second)),
    );
  }

  /** A ledger writes a path from the folder that its text names, so the end of the path counts. */
  #names(name: string, file: string): boolean {
    return file === name || file.endsWith(`/${name}`);
  }
}
