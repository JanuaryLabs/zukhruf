/** The default folder is not a folder, is a link, belongs to another user, or gives access to its group or others. */
export class UnsafeFolderError extends Error {
  /** The default folder. */
  readonly path: string;

  constructor(
    path: string,
    problem: 'is not a folder' | 'has unsafe permissions',
  ) {
    super(`${path} ${problem}`);
    this.name = 'UnsafeFolderError';
    this.path = path;
  }
}
