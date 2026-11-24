/** A table, schema or column name as one SQL Server identifier: a `]` inside it is doubled, so the name never ends the identifier. */
export const identifier = (name: string): string =>
  `[${name.replaceAll(']', ']]')}]`;
