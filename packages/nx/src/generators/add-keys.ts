/**
 * Adds each key of `defaults` that `record` does not have, after the keys
 * that are there. A key that is there keeps its value and its place, so a run
 * on a repo that has the keys in another order writes the same file.
 */
export function addMissingKeys<T>(
  record: Record<string, T> | undefined,
  defaults: Record<string, T>,
): Record<string, T> {
  const merged = { ...record };
  for (const [key, value] of Object.entries(defaults)) {
    if (!Object.hasOwn(merged, key)) merged[key] = value;
  }
  return merged;
}
