/** A table or column name as one SQL identifier, as SQLite and Postgres quote it: a `"` inside it is doubled, so the name never ends the identifier. */
export const identifier = (name: string): string =>
  `"${name.replaceAll('"', '""')}"`;
