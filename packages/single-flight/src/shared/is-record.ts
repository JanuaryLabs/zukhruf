/** Narrows a parsed or received value to an object whose fields can be checked one by one. */
export const isRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;
