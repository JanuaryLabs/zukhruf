/** Readers for values that arrive as `unknown`: rule options, manifests, parsed JSON. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The string entries of `value[key]`: options and manifests arrive as `unknown`. */
export function stringsAt(value: unknown, key: string): string[] {
  const list = isRecord(value) ? value[key] : undefined;
  return Array.isArray(list)
    ? list.filter((item): item is string => typeof item === 'string')
    : [];
}
