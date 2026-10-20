/** An item on one axis: it covers tracks `[start, start + span)` and needs `size` across them. */
export type TrackItem = { start: number; span: number; size: number };

/** Where the tracks and gutters of one axis lie, after sizing. */
export type TrackLine = {
  trackStart(track: number): number;
  trackEnd(track: number): number;
  gutterStart(boundary: number): number;
};

/**
 * Sizes the tracks of one axis the way CSS Grid sizes auto tracks: each track
 * first fits its widest single-track item; then each spanning item, smallest
 * span first, spreads what it still lacks equally over the tracks it spans.
 * A track with no items is 0.
 */
export function sizeTracks(
  count: number,
  items: TrackItem[],
  gutters: number[],
): TrackLine {
  const sizes = Array.from({ length: count }, () => 0);
  for (const item of items.filter((item) => item.span === 1)) {
    sizes[item.start] = Math.max(sizes[item.start]!, item.size);
  }
  const spanning = items
    .filter((item) => item.span > 1)
    .sort((a, b) => a.span - b.span);
  for (const { start, span, size } of spanning) {
    const end = start + span;
    const tracks = sizes.slice(start, end).reduce((sum, s) => sum + s, 0);
    const inner = gutters
      .slice(start + 1, end)
      .reduce((sum, gutter) => sum + gutter, 0);
    const deficit = size - tracks - inner;
    if (deficit <= 0) continue;
    for (let track = start; track < end; track++) {
      sizes[track]! += deficit / span;
    }
  }

  const starts: number[] = [];
  let offset = 0;
  for (let track = 0; track < count; track++) {
    offset += gutters[track]!;
    starts.push(offset);
    offset += sizes[track]!;
  }
  const trackEnd = (track: number) => starts[track]! + sizes[track]!;
  return {
    trackStart: (track) => starts[track]!,
    trackEnd,
    gutterStart: (boundary) => (boundary === 0 ? 0 : trackEnd(boundary - 1)),
  };
}
