import type { DiagramEdge } from '../../model/diagram-ir.ts';
import { parseEndpointRef } from '../../model/endpoint-ref.ts';
import type { CellArea, GridAreas } from './areas.ts';
import { measureEdgeTags } from './measure.ts';
import { LAYOUT_TOKENS } from './tokens.ts';

export type Axis = 'row' | 'col';

/**
 * The space at one track boundary. Boundary b lies before track b, so
 * boundaries 0 and N are the outer edges of the grid.
 */
export type Gutter = {
  size: number;
  /** For each depth, how far from the gutter's start the border of a group closing here lies. */
  closing: Map<number, number>;
  /** For each depth, how far from the gutter's start the border of a group opening here lies. */
  opening: Map<number, number>;
};

export type GridGutters = Record<Axis, Gutter[]>;

/** The border stroke a group draws, which its chrome must hold. */
const STROKE = 1;

type GroupSpan = {
  depth: number;
  start: number;
  end: number;
  openingChrome: number;
  closingChrome: number;
};

/**
 * Sizes every gutter before the tracks, because no gutter depends on a
 * track's size. A gutter holds, in order: the chrome of the groups closing
 * there (deepest first, next to the track before), a middle gap, and the
 * chrome of the groups opening there (deepest last, next to the track after).
 * Each depth's slot is as wide as its widest group anywhere along the
 * boundary, so every group border stays a straight line.
 */
export function gridGutters(
  areas: GridAreas,
  titleHeights: Map<string, number>,
  edges: DiagramEdge[],
): GridGutters {
  const minimums = tagMinimums(edges, areas.nodes);
  const chrome = LAYOUT_TOKENS.GROUP_PAD + STROKE;
  const spans = (axis: Axis): GroupSpan[] =>
    areas.groups.map(({ group, depth, area }) => {
      const [start, span] =
        axis === 'row' ? [area.row, area.rowSpan] : [area.col, area.colSpan];
      const title = axis === 'row' ? titleHeights.get(group.id)! : 0;
      const titleAtEnd = group.labelSide === 'bottom';
      return {
        depth,
        start,
        end: start + span,
        openingChrome: chrome + (titleAtEnd ? 0 : title),
        closingChrome: chrome + (titleAtEnd ? title : 0),
      };
    });
  return {
    row: axisGutters(areas.rows, spans('row'), minimums.row),
    col: axisGutters(areas.cols, spans('col'), minimums.col),
  };
}

function axisGutters(
  count: number,
  spans: GroupSpan[],
  minimums: Map<number, number>,
): Gutter[] {
  return Array.from({ length: count + 1 }, (_, boundary) => {
    const closing = slotWidths(
      spans.filter((span) => span.end === boundary),
      (span) => span.closingChrome,
    );
    const opening = slotWidths(
      spans.filter((span) => span.start === boundary),
      (span) => span.openingChrome,
    );
    const outer = boundary === 0 || boundary === count;
    const middle = Math.max(
      outer ? 0 : LAYOUT_TOKENS.GAP,
      minimums.get(boundary) ?? 0,
    );

    const closingEdges = new Map<number, number>();
    let offset = 0;
    for (const [depth, width] of [...closing].sort(([a], [b]) => b - a)) {
      offset += width;
      closingEdges.set(depth, offset);
    }
    offset += middle;
    const openingEdges = new Map<number, number>();
    for (const [depth, width] of [...opening].sort(([a], [b]) => a - b)) {
      openingEdges.set(depth, offset);
      offset += width;
    }
    return { size: offset, closing: closingEdges, opening: openingEdges };
  });
}

/** The width of each depth's slot: its widest chrome plus a channel for edges. */
function slotWidths(
  spans: GroupSpan[],
  chromeOf: (span: GroupSpan) => number,
): Map<number, number> {
  const widths = new Map<number, number>();
  for (const span of spans) {
    const width = chromeOf(span) + LAYOUT_TOKENS.CHANNEL;
    widths.set(span.depth, Math.max(widths.get(span.depth) ?? 0, width));
  }
  return widths;
}

/**
 * A tagged edge between two facing cells, with no node between them, runs
 * straight across the gutters between them, and the tracks between them may
 * be empty. Its label and its badge sit in a row along it, LABEL_GAP apart.
 * The tags must not straddle the border of a group that opens or closes
 * there, so the middles of those gutters, outside all their chrome, share
 * the row and a stub on each side of it.
 */
function tagMinimums(
  edges: DiagramEdge[],
  nodes: Map<string, CellArea>,
): Record<Axis, Map<number, number>> {
  const minimums: Record<Axis, Map<number, number>> = {
    row: new Map(),
    col: new Map(),
  };
  const raise = (axis: Axis, boundaries: number[], need: number) => {
    for (const boundary of boundaries) {
      minimums[axis].set(
        boundary,
        Math.max(minimums[axis].get(boundary) ?? 0, need / boundaries.length),
      );
    }
  };
  const areas = [...nodes.values()];
  for (const edge of edges) {
    const { label, badge } = measureEdgeTags(edge);
    const tags = [label, badge].filter((tag) => tag !== undefined);
    if (tags.length === 0) continue;
    const from = nodes.get(parseEndpointRef(edge.from).nodeId);
    const to = nodes.get(parseEndpointRef(edge.to).nodeId);
    if (!from || !to) continue;
    const rowLength = (along: 'w' | 'h') =>
      tags.reduce((sum, tag) => sum + tag[along], 0) +
      (tags.length - 1) * LAYOUT_TOKENS.LABEL_GAP +
      2 * LAYOUT_TOKENS.STUB;
    raise('col', facingBoundaries(from, to, areas), rowLength('w'));
    raise(
      'row',
      facingBoundaries(transpose(from), transpose(to), areas.map(transpose)),
      rowLength('h'),
    );
  }
  return minimums;
}

/**
 * The column boundaries between two areas that share rows and face each
 * other across them, with no other area between them in the rows they share.
 */
function facingBoundaries(
  a: CellArea,
  b: CellArea,
  areas: CellArea[],
): number[] {
  const top = Math.max(a.row, b.row);
  const bottom = Math.min(a.row + a.rowSpan, b.row + b.rowSpan);
  const [left, right] = a.col < b.col ? [a, b] : [b, a];
  const start = left.col + left.colSpan;
  const end = right.col;
  if (top >= bottom || start > end) return [];
  const blocked = areas.some(
    (area) =>
      area.col < end &&
      area.col + area.colSpan > start &&
      area.row < bottom &&
      area.row + area.rowSpan > top,
  );
  if (blocked) return [];
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function transpose(area: CellArea): CellArea {
  return {
    row: area.col,
    col: area.row,
    rowSpan: area.colSpan,
    colSpan: area.rowSpan,
  };
}
