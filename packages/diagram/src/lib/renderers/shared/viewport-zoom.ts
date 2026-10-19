export function normalizeZoom(zoom: number | undefined) {
  const value = zoom ?? 1;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Diagram viewport zoom must be a positive finite number, got ${String(
        zoom,
      )}.`,
    );
  }
  return value;
}

export function roundDimension(value: number) {
  return Math.round(value * 1000) / 1000;
}

export function formatZoom(value: number) {
  return String(roundDimension(value));
}
