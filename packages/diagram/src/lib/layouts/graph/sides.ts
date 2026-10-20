import type { Box, DiagramSide, Point } from '../../model/diagram-ir.ts';
import type { CellArea } from './areas.ts';
import type { Heading } from './route-search.ts';

export const OPPOSITE: Record<DiagramSide, DiagramSide> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

/** The heading of a line that leaves a box through `side`. */
export const OUTWARD: Record<DiagramSide, Heading> = {
  right: 0,
  left: 1,
  bottom: 2,
  top: 3,
};

export function isVertical(side: DiagramSide): boolean {
  return side === 'top' || side === 'bottom';
}

/** The side a connection leaves by, and the side it enters by. */
export type SidePair = [DiagramSide, DiagramSide];

/**
 * The pairs of sides a connection may leave and enter by, read from the
 * cells, in order of preference. First the facing pair: areas that share
 * rows face left and right, areas that share columns face top and bottom,
 * and otherwise the axis with the larger cell delta wins, the vertical one
 * on a tie. Then the facing pair on the other axis, then the first pair's
 * exit with the other pair's entry, then the other pair's exit with the
 * first pair's entry.
 */
export function sidePairs(
  from: CellArea,
  to: CellArea,
): [SidePair, ...SidePair[]] {
  const shareRows =
    Math.max(from.row, to.row) <
    Math.min(from.row + from.rowSpan, to.row + to.rowSpan);
  const shareCols =
    Math.max(from.col, to.col) <
    Math.min(from.col + from.colSpan, to.col + to.colSpan);
  const dr = to.row + to.rowSpan / 2 - (from.row + from.rowSpan / 2);
  const dc = to.col + to.colSpan / 2 - (from.col + from.colSpan / 2);
  const across: SidePair = dc > 0 ? ['right', 'left'] : ['left', 'right'];
  const down: SidePair = dr >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
  const horizontal =
    shareRows !== shareCols ? shareRows : Math.abs(dc) > Math.abs(dr);
  const [first, other] = horizontal ? [across, down] : [down, across];
  return [first, other, [first[0], other[1]], [other[0], first[1]]];
}

/** The coordinate of the side's line: x for left and right, y for top and bottom. */
export function sideLine(box: Box, side: DiagramSide): number {
  switch (side) {
    case 'top':
      return box.y;
    case 'bottom':
      return box.y + box.h;
    case 'left':
      return box.x;
    case 'right':
      return box.x + box.w;
  }
}

/** Where the side runs along its line: [start, end] in x for top and bottom, in y for left and right. */
export function sideSpan(box: Box, side: DiagramSide): [number, number] {
  return isVertical(side) ? [box.x, box.x + box.w] : [box.y, box.y + box.h];
}

/** The point on `side` of `box` at `along` on the side's span. */
export function pointOnSide(box: Box, side: DiagramSide, along: number): Point {
  const line = sideLine(box, side);
  return isVertical(side) ? { x: along, y: line } : { x: line, y: along };
}

/** The point `distance` beyond `point` out of `side`. */
export function beyond(
  point: Point,
  side: DiagramSide,
  distance: number,
): Point {
  switch (side) {
    case 'top':
      return { x: point.x, y: point.y - distance };
    case 'bottom':
      return { x: point.x, y: point.y + distance };
    case 'left':
      return { x: point.x - distance, y: point.y };
    case 'right':
      return { x: point.x + distance, y: point.y };
  }
}
