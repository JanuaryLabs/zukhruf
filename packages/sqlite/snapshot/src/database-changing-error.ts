/** The owner wrote the database while each copy of it was taken. */
export class DatabaseChangingError extends Error {
  readonly path: string;
  readonly attempts: number;

  constructor(path: string, attempts: number) {
    super(
      `The owner of the database at ${JSON.stringify(path)} wrote it while each of ${attempts} copies was taken. Read it again later.`,
    );
    this.name = 'DatabaseChangingError';
    this.path = path;
    this.attempts = attempts;
  }
}
