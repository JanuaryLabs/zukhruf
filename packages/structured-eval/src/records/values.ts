// null and an absent key both mean that a field has no value.
export const hasValue = (value: unknown) =>
  value !== null && value !== undefined;

export const isRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
