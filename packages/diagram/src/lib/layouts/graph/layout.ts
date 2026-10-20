import type { Box, DiagramGraphIR, Point } from '../../model/diagram-ir.ts';
import { type CellArea, type GroupArea, gridAreas } from './areas.ts';
import type {
  GraphLayout,
  GroupLayout,
  NodeLayout,
} from './graph-layout-result.ts';
import { type Axis, type GridGutters, gridGutters } from './gutters.ts';
import {
  type MeasuredGroupTitle,
  type MeasuredNode,
  measureGroupTitle,
  measureNode,
} from './measure.ts';
import { LAYOUT_TOKENS } from './tokens.ts';
import { type TrackLine, sizeTracks } from './tracks.ts';

/**
 * Lays out a graph on a content-sized grid: it measures every node, sizes
 * each row and column to the content in it, and reserves the chrome of the
 * groups in the gutters between them. It throws when the grid cannot be
 * drawn without overlap.
 */
export function layoutGraph(ir: DiagramGraphIR): GraphLayout {
  const measured = new Map(
    ir.nodes.map(
      (node) => [node.id, measureNode(node, LAYOUT_TOKENS)] as const,
    ),
  );
  const titles = new Map(
    ir.groups.map(
      (group) => [group.id, measureGroupTitle(group, LAYOUT_TOKENS)] as const,
    ),
  );
  const areas = gridAreas(ir);
  const gutters = gridGutters(
    areas,
    new Map([...titles].map(([id, title]) => [id, title.height])),
    ir.edges,
  );

  const items = (axis: Axis) =>
    ir.nodes.map((node) => {
      const area = areas.nodes.get(node.id)!;
      const { frame, overhang } = measured.get(node.id)!;
      return axis === 'row'
        ? {
            start: area.row,
            span: area.rowSpan,
            size: frame.h + overhang.top + overhang.bottom,
          }
        : {
            start: area.col,
            span: area.colSpan,
            size: frame.w + overhang.left + overhang.right,
          };
    });
  const line = (axis: Axis, count: number) =>
    sizeTracks(
      count,
      items(axis),
      gutters[axis].map((gutter) => gutter.size),
    );
  const lines: Record<Axis, TrackLine> = {
    row: line('row', areas.rows),
    col: line('col', areas.cols),
  };

  const nodes: NodeLayout[] = ir.nodes.map((node) => {
    const measuredNode = measured.get(node.id)!;
    const area = areaBox(areas.nodes.get(node.id)!, lines);
    return { node, ...measuredNode.place(nodeFrame(measuredNode, area)) };
  });
  const groups = areas.groups.map((groupArea) =>
    placeGroup(groupArea, titles.get(groupArea.group.id)!, lines, gutters),
  );

  return {
    nodes,
    groups,
    edges: [],
    leaders: [],
    viewBox: viewBoxOf(nodes, groups),
  };
}

function areaBox(area: CellArea, lines: Record<Axis, TrackLine>): Box {
  const x = lines.col.trackStart(area.col);
  const y = lines.row.trackStart(area.row);
  return {
    x,
    y,
    w: lines.col.trackEnd(area.col + area.colSpan - 1) - x,
    h: lines.row.trackEnd(area.row + area.rowSpan - 1) - y,
  };
}

/** A stretching node fills its area; any other node keeps its measured frame, centred in the area. */
function nodeFrame(measured: MeasuredNode, area: Box): Box {
  const { frame, overhang, stretch } = measured;
  if (stretch) {
    return {
      x: area.x + overhang.left,
      y: area.y + overhang.top,
      w: area.w - overhang.left - overhang.right,
      h: area.h - overhang.top - overhang.bottom,
    };
  }
  const visualW = frame.w + overhang.left + overhang.right;
  const visualH = frame.h + overhang.top + overhang.bottom;
  return {
    x: area.x + (area.w - visualW) / 2 + overhang.left,
    y: area.y + (area.h - visualH) / 2 + overhang.top,
    ...frame,
  };
}

/** Each side of a group lies on the outer edge of its chrome slot in the gutter where the group opens or closes. */
function placeGroup(
  { group, depth, area }: GroupArea,
  title: MeasuredGroupTitle,
  lines: Record<Axis, TrackLine>,
  gutters: GridGutters,
): GroupLayout {
  const border = (axis: Axis, boundary: number, side: 'opening' | 'closing') =>
    lines[axis].gutterStart(boundary) +
    gutters[axis][boundary]![side].get(depth)!;
  const x = border('col', area.col, 'opening');
  const y = border('row', area.row, 'opening');
  const rect = {
    x,
    y,
    w: border('col', area.col + area.colSpan, 'closing') - x,
    h: border('row', area.row + area.rowSpan, 'closing') - y,
  };
  return {
    group,
    depth,
    rect,
    ...title.place(rect),
    dividers: group.dividers
      ? dividers(rect, area, title, group.labelSide, lines, gutters)
      : [],
  };
}

/** A line through the middle of every gutter inside the group, clear of its title. */
function dividers(
  rect: Box,
  area: CellArea,
  title: MeasuredGroupTitle,
  labelSide: 'top' | 'bottom' | undefined,
  lines: Record<Axis, TrackLine>,
  gutters: GridGutters,
): [Point, Point][] {
  const centre = (axis: Axis, boundary: number) =>
    lines[axis].gutterStart(boundary) + gutters[axis][boundary]!.size / 2;
  const titleAtBottom = labelSide === 'bottom';
  const top = rect.y + (titleAtBottom ? 0 : title.height);
  const bottom = rect.y + rect.h - (titleAtBottom ? title.height : 0);
  const inner = (start: number, span: number) =>
    Array.from({ length: span - 1 }, (_, index) => start + index + 1);
  return [
    ...inner(area.col, area.colSpan).map((boundary): [Point, Point] => {
      const x = centre('col', boundary);
      return [
        { x, y: top },
        { x, y: bottom },
      ];
    }),
    ...inner(area.row, area.rowSpan).map((boundary): [Point, Point] => {
      const y = centre('row', boundary);
      return [
        { x: rect.x, y },
        { x: rect.x + rect.w, y },
      ];
    }),
  ];
}

function viewBoxOf(nodes: NodeLayout[], groups: GroupLayout[]): Box {
  const boxes = [
    ...nodes.map((nodeLayout) => nodeLayout.visual),
    ...groups.map((groupLayout) => groupLayout.rect),
  ];
  const pad = LAYOUT_TOKENS.CONTENT_PAD;
  if (boxes.length === 0) return { x: -pad, y: -pad, w: 2 * pad, h: 2 * pad };
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return {
    x: left - pad,
    y: top - pad,
    w: right - left + 2 * pad,
    h: bottom - top + 2 * pad,
  };
}
