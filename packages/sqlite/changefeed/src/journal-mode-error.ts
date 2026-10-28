/** The database is not in WAL mode, so a pass would stop the commits of its owner. */
export class JournalModeError extends Error {
  readonly path: string;
  readonly journalMode: string;

  constructor(path: string, journalMode: string) {
    super(
      `The database at ${JSON.stringify(path)} is in journal mode ${journalMode}, not wal: a read would stop the commits of its owner. Only the owner can change the mode.`,
    );
    this.name = 'JournalModeError';
    this.path = path;
    this.journalMode = journalMode;
  }
}
