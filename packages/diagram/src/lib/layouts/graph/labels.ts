import type { Box, Point } from '../../model/diagram-ir.ts';
import { LAYOUT_TOKENS } from './tokens.ts';

/** Where along a segment a tag is tried, in order. */
const FRACTIONS = [0.5, 0.3, 0.7, 0.15, 0.85];

/**
 * The first free position for a tag of `size` on the route: the longest
 * segment first, and on each segment the fractions in FRACTIONS order. A
 * label sits LABEL_GAP beside the segment (above, then below a horizontal
 * one; right, then left of a vertical one). A badge sits centred on it.
 */
export function tagPosition(
  size: { w: number; h: number },
  points: Point[],
  placement: 'beside' | 'on',
  isFree: (box: Box) => boolean,
): Box | undefined {
  const segments = points
    .slice(1)
    .map((to, segment) => ({ from: points[segment]!, to, segment }))
    .sort(
      (a, b) =>
        length(b.from, b.to) - length(a.from, a.to) || a.segment - b.segment,
    );
  for (const { from, to, segment } of segments) {
    for (const t of FRACTIONS) {
      const at = {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
      };
      for (const box of candidates(size, at, from.y === to.y, placement)) {
        if (isFree(box)) return box;
      }
    }
  }
  return undefined;
}

function candidates(
  { w, h }: { w: number; h: number },
  at: Point,
  horizontal: boolean,
  placement: 'beside' | 'on',
): Box[] {
  const gap = LAYOUT_TOKENS.LABEL_GAP;
  if (placement === 'on') return [{ x: at.x - w / 2, y: at.y - h / 2, w, h }];
  if (horizontal) {
    return [
      { x: at.x - w / 2, y: at.y - gap - h, w, h },
      { x: at.x - w / 2, y: at.y + gap, w, h },
    ];
  }
  return [
    { x: at.x + gap, y: at.y - h / 2, w, h },
    { x: at.x - gap - w, y: at.y - h / 2, w, h },
  ];
}

function length(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}
