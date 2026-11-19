const identifier = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * The parts of a table name, an optional schema and the name. The name goes
 * into the SQL text, quoted, so only letters, digits and underscores pass.
 */
export function tableNameParts(table: string): string[] {
  if (!identifier.test(table))
    throw new TypeError(
      `The table name ${JSON.stringify(table)} is not an identifier: use letters, digits and underscores, with an optional schema before a dot.`,
    );
  return table.split('.');
}
