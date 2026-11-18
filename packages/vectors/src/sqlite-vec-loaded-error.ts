/** `install` on a database that loaded sqlite-vec, which already has these functions. */
export class SqliteVecLoadedError extends Error {
  override readonly name = 'SqliteVecLoadedError';

  constructor() {
    super(
      'The database loaded sqlite-vec, which already has vec_distance_cosine and vec_distance_L2',
    );
  }
}
