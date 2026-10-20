import type { DiagramEdge } from '../../model/diagram-ir.ts';
import { parseEndpointRef } from '../../model/endpoint-ref.ts';
import type { CellArea, GridAreas } from './areas.ts';
import { measureEdgeLabel } from './measure.ts';
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
  const minimums = labelMinimums(edges, areas.nodes);
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
 * A labelled edge between two neighbouring cells has only the gutter between
 * them for its label. The label must not straddle the border of a group that
 * opens or closes there, so the middle of that gutter, outside all their
 * chrome, must hold the label and a stub on each side of it.
 */
function labelMinimums(
  edges: DiagramEdge[],
  nodes: Map<string, CellArea>,
): Record<Axis, Map<number, number>> {
  const minimums: Record<Axis, Map<number, number>> = {
    row: new Map(),
    col: new Map(),
  };
  const raise = (axis: Axis, boundary: number, need: number) =>
    minimums[axis].set(
      boundary,
      Math.max(minimums[axis].get(boundary) ?? 0, need),
    );
  for (const edge of edges) {
    if (!edge.label?.length) continue;
    const from = nodes.get(parseEndpointRef(edge.from).nodeId);
    const to = nodes.get(parseEndpointRef(edge.to).nodeId);
    if (!from || !to) continue;
    const label = measureEdgeLabel(edge);
    const side = sideBySide(from, to);
    if (side) raise('col', side, label.w + 2 * LAYOUT_TOKENS.STUB);
    const stacked = sideBySide(transpose(from), transpose(to));
    if (stacked) raise('row', stacked, label.h + 2 * LAYOUT_TOKENS.STUB);
  }
  return minimums;
}

/** The column boundary between two areas that share rows and touch across it. */
function sideBySide(a: CellArea, b: CellArea): number | undefined {
  const shareRows =
    Math.max(a.row, b.row) < Math.min(a.row + a.rowSpan, b.row + b.rowSpan);
  if (!shareRows) return undefined;
  if (a.col + a.colSpan === b.col) return b.col;
  if (b.col + b.colSpan === a.col) return a.col;
  return undefined;
}

function transpose(area: CellArea): CellArea {
  return {
    row: area.col,
    col: area.row,
    rowSpan: area.colSpan,
    colSpan: area.rowSpan,
  };
}
