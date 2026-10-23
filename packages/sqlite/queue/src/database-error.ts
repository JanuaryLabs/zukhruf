// pg-boss surfaces some driver errors as they are, and node-postgres and
// PGlite both name those `error` and carry Postgres's SQLSTATE as `code`
// (node_modules/pg-protocol/dist/messages.js:36-41).
export class DatabaseError extends Error {
  override name = 'error';
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}
