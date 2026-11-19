const identifier = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** The table name goes into the SQL text, so only a plain identifier, with an optional schema, passes. */
export function tableName(table: string): string {
  if (!identifier.test(table))
    throw new TypeError(
      `The table name ${JSON.stringify(table)} is not an identifier: use letters, digits and underscores, with an optional schema before a dot.`,
    );
  return table;
}
