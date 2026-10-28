/** The database lacks columns that a reader reads: its owner changed its layout. */
export class MissingColumnsError extends Error {
  readonly path: string;
  readonly missing: readonly string[];

  constructor(path: string, missing: readonly string[]) {
    super(
      `The database at ${JSON.stringify(path)} lacks the columns ${missing.join(', ')}: its owner changed its layout. Update the reader to the new layout.`,
    );
    this.name = 'MissingColumnsError';
    this.path = path;
    this.missing = missing;
  }
}
