import type { Box, Point } from '../../model/diagram-ir.ts';
import { LAYOUT_TOKENS } from './tokens.ts';

/** Where along a segment the tags are tried, in order. */
const FRACTIONS = [0.5, 0.3, 0.7, 0.15, 0.85];

type Size = { w: number; h: number };

export type TagKind = 'label' | 'badge';

/**
 * The first free position for an edge's tags on its route: the longest
 * segment first, and on each segment the fractions in FRACTIONS order. A
 * label sits LABEL_GAP beside the segment (above, then below a horizontal
 * one; right, then left of a vertical one). A badge sits centred on it. An
 * edge with both puts them in a row along the segment, LABEL_GAP apart and
 * centred on the fraction: the label first, then the badge first.
 */
export function tagPosition(
  tags: { label?: Size; badge?: Size },
  points: Point[],
  isFree: (box: Box, kind: TagKind) => boolean,
): { label?: Box; badge?: Box } | undefined {
  const { label, badge } = tags;
  const freeLabel = (size: Size, at: Point, horizontal: boolean) =>
    beside(size, at, horizontal).find((box) => isFree(box, 'label'));
  const freeBadge = (size: Size, at: Point) => {
    const box = on(size, at);
    return isFree(box, 'badge') ? box : undefined;
  };
  const segments = points
    .slice(1)
    .map((to, segment) => ({ from: points[segment]!, to, segment }))
    .sort(
      (a, b) =>
        length(b.from, b.to) - length(a.from, a.to) || a.segment - b.segment,
    );
  for (const { from, to } of segments) {
    const horizontal = from.y === to.y;
    for (const t of FRACTIONS) {
      const at = {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
      };
      if (label && badge) {
        const along = ({ w, h }: Size) => (horizontal ? w : h);
        const half =
          (along(label) + LAYOUT_TOKENS.LABEL_GAP + along(badge)) / 2;
        for (const first of [-1, 1]) {
          const labelBox = freeLabel(
            label,
            shift(at, horizontal, first * (half - along(label) / 2)),
            horizontal,
          );
          const badgeBox = freeBadge(
            badge,
            shift(at, horizontal, -first * (half - along(badge) / 2)),
          );
          if (labelBox && badgeBox) return { label: labelBox, badge: badgeBox };
        }
      } else if (label) {
        const labelBox = freeLabel(label, at, horizontal);
        if (labelBox) return { label: labelBox };
      } else if (badge) {
        const badgeBox = freeBadge(badge, at);
        if (badgeBox) return { badge: badgeBox };
      }
    }
  }
  return undefined;
}

function beside({ w, h }: Size, at: Point, horizontal: boolean): Box[] {
  const gap = LAYOUT_TOKENS.LABEL_GAP;
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

function on({ w, h }: Size, at: Point): Box {
  return { x: at.x - w / 2, y: at.y - h / 2, w, h };
}

function shift(at: Point, horizontal: boolean, by: number): Point {
  return horizontal ? { x: at.x + by, y: at.y } : { x: at.x, y: at.y + by };
}

function length(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}
