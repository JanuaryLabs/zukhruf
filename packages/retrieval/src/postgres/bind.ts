/**
 * Adds a value to the positional parameters of a statement and gives its
 * placeholder, `$1` for the first, as the Postgres wire protocol numbers them.
 */
export function bind(parameters: unknown[], value: unknown): string {
  parameters.push(value);
  return `$${parameters.length}`;
}
