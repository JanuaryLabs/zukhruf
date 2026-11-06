// null and an absent key both mean that a field has no value.
export const hasValue = (value: unknown) =>
  value !== null && value !== undefined;
