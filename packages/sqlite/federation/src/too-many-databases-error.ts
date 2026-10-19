// One statement names more databases than one SQLite connection can attach.
export class TooManyDatabasesError extends Error {
  readonly names: readonly string[];

  constructor(limit: number, names: readonly string[]) {
    super(
      `One statement can read at most ${limit} databases, and this one names at least ${names.length}: ${names.join(', ')}. Split it into statements that each name ${limit} or fewer, and join their rows in code.`,
    );
    this.name = 'TooManyDatabasesError';
    this.names = names;
  }
}
