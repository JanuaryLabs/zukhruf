/**
 * Adds a value to the named parameters of a statement and gives its
 * placeholder: `@p0` for the first, `@p1` for the next.
 */
export function bind(
  parameters: Record<string, unknown>,
  value: unknown,
): string {
  const name = `p${Object.keys(parameters).length}`;
  parameters[name] = value;
  return `@${name}`;
}
