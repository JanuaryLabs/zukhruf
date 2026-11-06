// A duration that a watch can wait: a positive, finite number of
// milliseconds. Zero or less would check with no wait, and no number would
// never check.
export function milliseconds(name: string, ms: number): number {
  if (!(ms > 0 && Number.isFinite(ms)))
    throw new RangeError(
      `${name} must be a positive number of milliseconds, not ${ms}`,
    );
  return ms;
}
