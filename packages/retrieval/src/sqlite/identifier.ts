/** A table or column name as one SQLite identifier: a `"` inside it is doubled, so the name never ends the identifier. */
export const identifier = (name: string): string =>
  `"${name.replaceAll('"', '""')}"`;
