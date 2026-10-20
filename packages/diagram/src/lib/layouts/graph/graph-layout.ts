import type {
  Box,
  DiagramAnchor,
  DiagramAnnotation,
  DiagramAnnotationLeader,
  DiagramEdge,
  DiagramGraphLayout,
  DiagramGroup,
  DiagramGuide,
  DiagramGuideOrientation,
  DiagramNode,
  DiagramNodePort,
  DiagramSide,
  DiagramWaypoint,
  GraphLayoutSpec,
  Point,
} from '../../model/diagram-ir.ts';
import { parseEndpointRef } from '../../model/endpoint-ref.ts';
import {
  centeredBaselineOffset,
  textAscent,
  textLineBox,
  textWidth,
  widestLine,
} from '../text-metrics.ts';

export type {
  DiagramAnnotation,
  DiagramAnnotationLeader,
  DiagramAnchor,
  DiagramEdge,
  DiagramEdgeLabelSide,
  DiagramGraphLayout,
  DiagramGroup,
  DiagramGuide,
  DiagramGuideOrientation,
  DiagramLabelLine,
  DiagramNode,
  DiagramNodeIcon,
  DiagramNodePort,
  DiagramWaypoint,
  GraphLayoutSpec,
  Box,
  Point,
  DiagramSide,
} from '../../model/diagram-ir.ts';

export const COL_W = 240;
export const ROW_H = 128;
export const NODE_W = 176;
export const NODE_H = 64;
export const NODE_RX = 16;
export const NODE_PAD = 16;
export const GROUP_PAD = 24;
export const GROUP_LABEL_H = 28;
export const GROUP_TITLE_GAP = 8;
export const TITLE_TOP_PAD = 32;
export const SVG_PAD_X = 60;
export const SVG_PAD_Y = 32;
export const ROUTE_CELL = 4;
export const TURN_PENALTY = 14;
export const STUB = NODE_PAD + ROUTE_CELL;
export const ENTRY_GAP = 10;
export const CONTENT_VIEWBOX_PAD = 40;

export const PARALLEL_SPACING = 28;
const SELF_LOOP_OFFSET = 28;
const SELF_LOOP_DEPTH = 48;
const ROUTE_RESERVATION_CELLS = 0;
const EDGE_LABEL_FONT_SIZE = 10;
const EDGE_BADGE_FONT_SIZE = 10;
export const EDGE_BADGE_ICON = 22;
const EDGE_LABEL_LINE_H = 12;
const EDGE_LABEL_LINE_GAP = 2;
const EDGE_LABEL_BOX_PAD = 4;
const EDGE_LABEL_GAP = 4;
const GROUP_LABEL_LINE_H = 14;
const NODE_CAPTION_FONT_SIZE = 11;
const NODE_CAPTION_LINE_H = 14;
const NODE_CAPTION_OFFSET = 12;
const NODE_CAPTION_FRAME_PAD_X_EM = 0.9;
const NODE_CAPTION_FRAME_PAD_Y_EM = 0.55;
const ANNOTATION_LINE_GAP = 4;

export function nodeFrameRadius(node: DiagramNode) {
  return node.rx ?? (node.frame === 'flat' ? 4 : NODE_RX);
}

type Axis = 'col' | 'row';

function graphLayout(
  layout?: DiagramGraphLayout,
): Required<DiagramGraphLayout> {
  return {
    colWidth: layout?.colWidth ?? COL_W,
    rowHeight: layout?.rowHeight ?? ROW_H,
    columns: layout?.columns ?? [],
    rows: layout?.rows ?? [],
    padX: layout?.padX ?? SVG_PAD_X,
    padY: layout?.padY ?? SVG_PAD_Y,
    titleTopPad: layout?.titleTopPad ?? TITLE_TOP_PAD,
  };
}

function trackSize(
  axis: Axis,
  index: number,
  layout?: DiagramGraphLayout,
): number {
  const resolved = graphLayout(layout);
  const tracks = axis === 'col' ? resolved.columns : resolved.rows;
  const fallback = axis === 'col' ? resolved.colWidth : resolved.rowHeight;
  return tracks[index] ?? fallback;
}

function assertTrackStart(axis: Axis, value: number) {
  if (Math.floor(value) < 0) {
    throw new Error(
      `Diagram ${axis === 'col' ? 'column' : 'row'} ${value} resolves before the first track.`,
    );
  }
}

function trackPosition(
  axis: Axis,
  value: number,
  layout?: DiagramGraphLayout,
): number {
  assertTrackStart(axis, value);
  const index = Math.floor(value);
  const fraction = value - index;
  let position = 0;
  for (let i = 0; i < index; i++) {
    position += trackSize(axis, i, layout);
  }
  if (fraction > 0) position += trackSize(axis, index, layout) * fraction;
  return position;
}

function trackSpan(
  axis: Axis,
  start: number,
  end: number,
  layout?: DiagramGraphLayout,
): number {
  return trackPosition(axis, end, layout) - trackPosition(axis, start, layout);
}

function graphPadX(layout?: DiagramGraphLayout) {
  return graphLayout(layout).padX;
}

function graphPadY(layout?: DiagramGraphLayout) {
  const resolved = graphLayout(layout);
  return resolved.padY + resolved.titleTopPad;
}

export type ViewBox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type GroupDividerLine = {
  axis: 'row' | 'col';
  value: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  accent: boolean;
};

export type ResolvedDiagramAnnotation = DiagramAnnotation & {
  x: number;
  y: number;
  leaderFrom?: Point | undefined;
  leaderTo?: Point | undefined;
  leaders?: DiagramAnnotationLeader[] | undefined;
};

export type PortPlacement = DiagramNodePort & {
  ownerId: string;
  x: number;
  y: number;
  labelX: number;
  labelY: number;
  labelAlign: 'start' | 'middle' | 'end';
};

export type NodeCaptionPlacement = {
  lines: string[];
  x: number;
  y: number;
  align: 'start' | 'middle' | 'end';
  fontSize: number;
  lineHeight: number;
};

type EndpointRef = {
  ref: string;
  id: string;
  kind: 'node' | 'group';
  box: Box;
  cornerInset: number;
  connectable: boolean;
  port?: DiagramNodePort;
};

type EndpointLookup = {
  nodesById: Map<string, DiagramNode>;
  nodeBoxes: Map<string, Box>;
  groupsById: Map<string, DiagramGroup>;
  groupBoxes: Map<string, Box>;
};

export function nodeBox(node: DiagramNode, layout?: DiagramGraphLayout): Box {
  const row = positionedValue(node, 'row');
  const col = positionedValue(node, 'col');
  const colSpan = node.colSpan ?? 1;
  const innerWidth = trackSpan('col', col, col + colSpan, layout);
  const defaultWidth = NODE_W + (colSpan - 1) * graphLayout(layout).colWidth;
  const w =
    node.width ?? Math.min(defaultWidth, Math.max(NODE_W, innerWidth - 24));
  const h = node.height ?? NODE_H;
  const x =
    graphPadX(layout) +
    trackPosition('col', col, layout) +
    (innerWidth - w) / 2;
  const rowHeight = trackSize('row', Math.floor(row), layout);
  const y =
    graphPadY(layout) + trackPosition('row', row, layout) + (rowHeight - h) / 2;
  return { x, y, w, h };
}

export function nodeStackCount(node: DiagramNode): number {
  return Math.max(1, Math.floor(node.stack ?? 1));
}

export function nodeStackOffset(node: DiagramNode): number {
  const stackOffset = node.stackOffset ?? 12;
  if (stackOffset < 0) {
    throw new Error(
      `Diagram node "${node.id}" stackOffset must be non-negative.`,
    );
  }
  return stackOffset;
}

export function nodeStackVector(node: DiagramNode): Point {
  const offset = nodeStackOffset(node);
  const dx = node.stackDx ?? offset;
  const dy = node.stackDy ?? offset;
  if (dx < 0) {
    throw new Error(`Diagram node "${node.id}" stackDx must be non-negative.`);
  }
  if (dy < 0) {
    throw new Error(`Diagram node "${node.id}" stackDy must be non-negative.`);
  }
  const direction = node.stackDirection ?? 'up-left';
  const xSign = direction.endsWith('left') ? -1 : 1;
  const ySign = direction.startsWith('up') ? -1 : 1;
  return { x: xSign * dx, y: ySign * dy };
}

export function nodeStackWidthStep(node: DiagramNode): number {
  const step = node.stackWidthStep ?? 0;
  if (step < 0) {
    throw new Error(
      `Diagram node "${node.id}" stackWidthStep must be non-negative.`,
    );
  }
  return step;
}

export function nodeStackHeightStep(node: DiagramNode): number {
  const step = node.stackHeightStep ?? 0;
  if (step < 0) {
    throw new Error(
      `Diagram node "${node.id}" stackHeightStep must be non-negative.`,
    );
  }
  return step;
}

export function nodeStackFrameBox(
  node: DiagramNode,
  box: Box,
  level: number,
): Box {
  const stackVector = nodeStackVector(node);
  return {
    x: box.x + level * stackVector.x,
    y: box.y + level * stackVector.y,
    w: box.w + level * nodeStackWidthStep(node),
    h: box.h + level * nodeStackHeightStep(node),
  };
}

export function nodeVisualBox(node: DiagramNode, box = nodeBox(node)): Box {
  const stackCount = nodeStackCount(node);
  if (stackCount <= 1 || node.hidden || node.frame === 'none') return box;
  const boxes = [
    box,
    ...Array.from({ length: stackCount - 1 }, (_, i) =>
      nodeStackFrameBox(node, box, i + 1),
    ),
  ];
  const minX = Math.min(...boxes.map((candidate) => candidate.x));
  const minY = Math.min(...boxes.map((candidate) => candidate.y));
  const maxX = Math.max(...boxes.map((candidate) => candidate.x + candidate.w));
  const maxY = Math.max(...boxes.map((candidate) => candidate.y + candidate.h));
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  };
}

export function nodeCaptionLines(node: DiagramNode): string[] {
  if (node.caption === undefined) return [];
  return (Array.isArray(node.caption) ? node.caption : [node.caption])
    .map((line) => line.trim())
    .filter(Boolean);
}

export function nodeCaptionPlacement(
  node: DiagramNode,
  box = nodeBox(node),
): NodeCaptionPlacement | null {
  const lines = nodeCaptionLines(node);
  if (node.hidden || lines.length === 0) return null;
  const side = node.captionSide ?? 'bottom';
  const offset =
    node.captionOffset ?? (node.captionFrame ? 0 : NODE_CAPTION_OFFSET);
  const fontSize = node.captionFontSize ?? NODE_CAPTION_FONT_SIZE;
  const lineHeight = Math.max(fontSize + 2, NODE_CAPTION_LINE_H);
  const centerX = box.x + box.w / 2;
  const centerY = box.y + box.h / 2;
  if (node.captionFrame) {
    const center =
      side === 'top'
        ? { x: centerX, y: box.y - offset }
        : side === 'bottom'
          ? { x: centerX, y: box.y + box.h + offset }
          : side === 'left'
            ? { x: box.x - offset, y: centerY }
            : { x: box.x + box.w + offset, y: centerY };
    return {
      lines,
      x: center.x,
      y:
        center.y -
        captionBlockHeight(node, fontSize, lines.length, lineHeight) / 2 +
        captionBlockAscent(node, fontSize),
      align: 'middle',
      fontSize,
      lineHeight,
    };
  }
  if (side === 'top') {
    return {
      lines,
      x: centerX,
      y: box.y - offset - (lines.length - 1) * lineHeight,
      align: 'middle',
      fontSize,
      lineHeight,
    };
  }
  if (side === 'left') {
    return {
      lines,
      x: box.x - offset,
      y: centerY - ((lines.length - 1) * lineHeight) / 2 + fontSize / 3,
      align: 'end',
      fontSize,
      lineHeight,
    };
  }
  if (side === 'right') {
    return {
      lines,
      x: box.x + box.w + offset,
      y: centerY - ((lines.length - 1) * lineHeight) / 2 + fontSize / 3,
      align: 'start',
      fontSize,
      lineHeight,
    };
  }
  return {
    lines,
    x: centerX,
    y: box.y + box.h + offset + fontSize,
    align: 'middle',
    fontSize,
    lineHeight,
  };
}

function captionFramePad(node: DiagramNode, fontSize: number) {
  return node.captionFrame ? fontSize * NODE_CAPTION_FRAME_PAD_Y_EM : 0;
}

function captionBlockAscent(node: DiagramNode, fontSize: number) {
  return textAscent(fontSize, 'sans') + captionFramePad(node, fontSize);
}

function captionBlockHeight(
  node: DiagramNode,
  fontSize: number,
  lineCount: number,
  lineHeight: number,
) {
  return (
    textLineBox(fontSize, 'sans') +
    (lineCount - 1) * lineHeight +
    captionFramePad(node, fontSize) * 2
  );
}

export function nodeCaptionBounds(
  node: DiagramNode,
  box = nodeBox(node),
): Box | null {
  const placement = nodeCaptionPlacement(node, box);
  if (!placement) return null;
  const w =
    widestLine(placement.lines, placement.fontSize, 'sans') +
    (node.captionFrame
      ? placement.fontSize * NODE_CAPTION_FRAME_PAD_X_EM * 2
      : 0);
  const h = captionBlockHeight(
    node,
    placement.fontSize,
    placement.lines.length,
    placement.lineHeight,
  );
  const x =
    placement.align === 'middle'
      ? placement.x - w / 2
      : placement.align === 'end'
        ? placement.x - w
        : placement.x;
  return {
    x,
    y: placement.y - captionBlockAscent(node, placement.fontSize),
    w,
    h,
  };
}

function positionedValue(node: DiagramNode, axis: 'row' | 'col') {
  const value = node[axis];
  if (value === undefined) {
    throw new Error(
      `Diagram node "${node.id}" needs a ${axis}; resolve automatic graph layout before measuring nodes.`,
    );
  }
  return value;
}

export function resolveGraphLayout(spec: GraphLayoutSpec): GraphLayoutSpec {
  const needsAutoLayout = spec.nodes.some(
    (node) => node.row === undefined || node.col === undefined,
  );
  let nodes = spec.nodes;

  if (needsAutoLayout) {
    for (const node of spec.nodes) {
      const hasRow = node.row !== undefined;
      const hasCol = node.col !== undefined;
      if (hasRow !== hasCol) {
        throw new Error(
          `Diagram node "${node.id}" needs both row and col, or neither for automatic graph layout.`,
        );
      }
    }

    const ids = spec.nodes.map((node) => node.id);
    const nodeIds = new Set(ids);
    const adjacency = new Map<string, string[]>();
    const indegree = new Map<string, number>();
    for (const id of ids) {
      adjacency.set(id, []);
      indegree.set(id, 0);
    }

    for (const edge of spec.edges) {
      const from = parseEndpointRef(edge.from).nodeId;
      const to = parseEndpointRef(edge.to).nodeId;
      if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) continue;
      adjacency.get(from)?.push(to);
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
    }

    const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
    const rank = new Map(ids.map((id) => [id, 0]));
    const order: string[] = [];
    // The loop visits the ids that it pushes onto the queue.
    for (const id of queue) {
      order.push(id);
      for (const to of adjacency.get(id) ?? []) {
        rank.set(to, Math.max(rank.get(to) ?? 0, (rank.get(id) ?? 0) + 1));
        indegree.set(to, (indegree.get(to) ?? 0) - 1);
        if (indegree.get(to) === 0) queue.push(to);
      }
    }

    if (order.length !== ids.length) {
      throw new Error(
        'Diagram automatic graph layout requires an acyclic graph. Set row and col manually for cycles.',
      );
    }

    const usedRowsByCol = new Map<number, Set<number>>();
    for (const node of spec.nodes) {
      if (node.row === undefined || node.col === undefined) continue;
      const rows = usedRowsByCol.get(node.col) ?? new Set<number>();
      rows.add(node.row);
      usedRowsByCol.set(node.col, rows);
    }

    const nextOpenRow = (col: number) => {
      const rows = usedRowsByCol.get(col) ?? new Set<number>();
      let row = 0;
      while (rows.has(row)) row += 1;
      rows.add(row);
      usedRowsByCol.set(col, rows);
      return row;
    };

    nodes = spec.nodes.map((node) => {
      if (node.row !== undefined && node.col !== undefined) return node;
      const col = rank.get(node.id) ?? 0;
      return {
        ...node,
        col,
        row: nextOpenRow(col),
      };
    });
  }

  const groups = resolveGraphGroupBounds(spec.groups, nodes);
  if (nodes === spec.nodes && groups === spec.groups) return spec;
  return { ...spec, nodes, groups };
}

function resolveGraphGroupBounds(
  groups: DiagramGroup[] | undefined,
  nodes: DiagramNode[],
): DiagramGroup[] | undefined {
  if (!groups?.length) return groups;
  let changed = false;
  const resolved = new Map<string, DiagramGroup>();
  const resolving = new Set<string>();

  const resolve = (group: DiagramGroup): DiagramGroup => {
    const cached = resolved.get(group.id);
    if (cached) return cached;
    if (resolving.has(group.id)) {
      throw new Error(
        `Diagram.Group "${group.id}" has a cyclic parent relationship.`,
      );
    }

    resolving.add(group.id);
    const childGroups = groups
      .filter((candidate) => candidate.parent === group.id)
      .map(resolve);

    let next = group;
    if (!group.bounds) {
      changed = true;
      next = {
        ...group,
        bounds: inferResolvedGroupBounds(group, nodes, childGroups),
      };
    }

    resolving.delete(group.id);
    resolved.set(group.id, next);
    return next;
  };

  const nextGroups = groups.map(resolve);
  return changed ? nextGroups : groups;
}

function inferResolvedGroupBounds(
  group: DiagramGroup,
  nodes: DiagramNode[],
  childGroups: DiagramGroup[] = [],
): NonNullable<DiagramGroup['bounds']> {
  const grouped = nodes.filter((node) => node.group === group.id);
  if (grouped.length === 0 && childGroups.length === 0) {
    throw new Error(
      `Diagram.Group "${group.id}" needs bounds or direct node/group children so bounds can be inferred.`,
    );
  }
  const bounds = emptyBounds();
  for (const node of grouped) {
    const row = positionedValue(node, 'row');
    const col = positionedValue(node, 'col');
    includeBounds(bounds, {
      rowStart: row,
      rowEnd: row,
      colStart: col,
      colEnd: col + (node.colSpan ?? 1) - 1,
    });
  }
  for (const childGroup of childGroups) {
    includeBounds(bounds, requireGroupBounds(childGroup));
  }
  return bounds;
}

function emptyBounds(): NonNullable<DiagramGroup['bounds']> {
  return {
    rowStart: Number.POSITIVE_INFINITY,
    rowEnd: Number.NEGATIVE_INFINITY,
    colStart: Number.POSITIVE_INFINITY,
    colEnd: Number.NEGATIVE_INFINITY,
  };
}

function includeBounds(
  target: NonNullable<DiagramGroup['bounds']>,
  source: NonNullable<DiagramGroup['bounds']>,
) {
  target.rowStart = Math.min(target.rowStart, source.rowStart);
  target.rowEnd = Math.max(target.rowEnd, source.rowEnd);
  target.colStart = Math.min(target.colStart, source.colStart);
  target.colEnd = Math.max(target.colEnd, source.colEnd);
}

function groupCornerInset(group: DiagramGroup) {
  const frame = group.frame ?? 'solid';
  if (frame === 'none') return 0;
  return group.rx ?? 12;
}

export function groupBox(
  group: DiagramGroup,
  nodes?: DiagramNode[],
  layout?: DiagramGraphLayout,
  groups?: DiagramGroup[],
): Box {
  const bounds = requireGroupBounds(group);
  const padding = groupPadding(group);
  const contained = nodes?.filter((n) => n.group === group.id) ?? [];
  const childGroups =
    groups?.filter((candidate) => candidate.parent === group.id) ?? [];
  const childBoxes = nodes
    ? [
        ...contained.map((node) => nodeVisualBox(node, nodeBox(node, layout))),
        ...childGroups.map((childGroup) =>
          groupBox(childGroup, nodes, layout, groups),
        ),
      ]
    : [];
  const tightX = group.tightX && childBoxes.length > 0;
  const tightY = (group.tight || group.tightY) && childBoxes.length > 0;
  const minChildX =
    childBoxes.length > 0 ? Math.min(...childBoxes.map((b) => b.x)) : 0;
  const maxChildX =
    childBoxes.length > 0 ? Math.max(...childBoxes.map((b) => b.x + b.w)) : 0;
  const x = tightX
    ? minChildX - padding.left
    : graphPadX(layout) +
      trackPosition('col', bounds.colStart, layout) -
      padding.left;
  const w = tightX
    ? maxChildX - minChildX + padding.left + padding.right
    : trackSpan('col', bounds.colStart, bounds.colEnd + 1, layout) +
      padding.left +
      padding.right;

  if (tightY && nodes) {
    const boxes = childBoxes;
    if (boxes.length > 0) {
      const minY = Math.min(...boxes.map((b) => b.y));
      const maxY = Math.max(...boxes.map((b) => b.y + b.h));
      const topPad = groupTopPadding(group, padding, true, bounds);
      const y = minY - topPad;
      const h = maxY - minY + topPad + padding.bottom;
      return { x, y, w, h };
    }
  }

  const y =
    graphPadY(layout) +
    trackPosition('row', bounds.rowStart, layout) -
    groupTopPadding(group, padding, false, bounds, nodes, layout, groups);
  const h =
    trackSpan('row', bounds.rowStart, bounds.rowEnd + 1, layout) +
    groupTopPadding(group, padding, false, bounds, nodes, layout, groups) +
    padding.bottom;
  return { x, y, w, h };
}

function groupTopPadding(
  group: DiagramGroup,
  padding: ReturnType<typeof groupPadding>,
  reserveTightLabel: boolean,
  bounds: NonNullable<DiagramGroup['bounds']>,
  nodes?: DiagramNode[],
  layout?: DiagramGraphLayout,
  groups?: DiagramGroup[],
) {
  const titleGutterHeight = groupTitleGutterHeight(group);
  const childOverhang =
    titleGutterHeight > 0 && nodes
      ? groupChildTopOverhang(group, bounds, nodes, layout, groups)
      : 0;
  const tightLabelReserve =
    reserveTightLabel && groupLabelHeight(group) > 0
      ? groupLabelHeight(group) + GROUP_TITLE_GAP
      : 0;
  return Math.max(
    padding.top,
    titleGutterHeight + childOverhang,
    tightLabelReserve,
  );
}

function groupChildTopOverhang(
  group: DiagramGroup,
  bounds: NonNullable<DiagramGroup['bounds']>,
  nodes: DiagramNode[],
  layout?: DiagramGraphLayout,
  groups?: DiagramGroup[],
) {
  const rowTop =
    graphPadY(layout) + trackPosition('row', bounds.rowStart, layout);
  const containedNodes = nodes.filter((node) => node.group === group.id);
  const childGroups =
    groups?.filter((candidate) => candidate.parent === group.id) ?? [];
  const childBoxes = [
    ...containedNodes.map((node) => nodeVisualBox(node, nodeBox(node, layout))),
    ...childGroups.map((childGroup) =>
      groupBox(childGroup, nodes, layout, groups),
    ),
  ];
  if (childBoxes.length === 0) return 0;
  return Math.max(0, ...childBoxes.map((box) => rowTop - box.y));
}

function groupPadding(group: DiagramGroup) {
  const padding = group.padding ?? GROUP_PAD;
  if (typeof padding === 'number') {
    return {
      top: padding,
      right: padding,
      bottom: padding,
      left: padding,
    };
  }
  return {
    top: padding.top ?? GROUP_PAD,
    right: padding.right ?? GROUP_PAD,
    bottom: padding.bottom ?? GROUP_PAD,
    left: padding.left ?? GROUP_PAD,
  };
}

export function groupLabelLines(group: DiagramGroup): string[] {
  if (Array.isArray(group.label)) return group.label;
  return group.label ? [group.label] : [];
}

export function groupLabelHeight(group: DiagramGroup): number {
  const lines = groupLabelLines(group);
  if (lines.length === 0) return 0;
  return GROUP_LABEL_H + (lines.length - 1) * GROUP_LABEL_LINE_H;
}

export function groupTitleGutterHeight(group: DiagramGroup): number {
  if (group.titleGap !== undefined && group.titleGap < 0) {
    throw new Error(
      `Diagram.Group "${group.id}" titleGap must be non-negative.`,
    );
  }
  const labelHeight = groupLabelHeight(group);
  if (labelHeight === 0) return 0;
  if (!group.titleBand && group.titleGap === undefined) return 0;
  return labelHeight + (group.titleGap ?? GROUP_TITLE_GAP);
}

function requireGroupBounds(
  group: DiagramGroup,
): NonNullable<DiagramGroup['bounds']> {
  if (!group.bounds) {
    throw new Error(
      `Diagram.Group "${group.id}" needs bounds; resolve automatic graph layout before measuring groups.`,
    );
  }
  return group.bounds;
}

export function groupDividerLines(
  group: DiagramGroup,
  nodes?: DiagramNode[],
  layout?: DiagramGraphLayout,
  groups?: DiagramGroup[],
): GroupDividerLine[] {
  const bounds = requireGroupBounds(group);
  const box = groupBox(group, nodes, layout, groups);
  const lines: GroupDividerLine[] = [];

  for (const row of group.dividers?.rows ?? []) {
    if (row <= bounds.rowStart || row > bounds.rowEnd) {
      throw new Error(
        `Diagram.Group "${group.id}" row divider ${row} is outside group bounds.`,
      );
    }
    const y = graphPadY(layout) + trackPosition('row', row, layout);
    lines.push({
      axis: 'row',
      value: row,
      x1: box.x,
      y1: y,
      x2: box.x + box.w,
      y2: y,
      accent: group.accent ?? false,
    });
  }

  for (const col of group.dividers?.cols ?? []) {
    if (col <= bounds.colStart || col > bounds.colEnd) {
      throw new Error(
        `Diagram.Group "${group.id}" column divider ${col} is outside group bounds.`,
      );
    }
    const x = graphPadX(layout) + trackPosition('col', col, layout);
    lines.push({
      axis: 'col',
      value: col,
      x1: x,
      y1: box.y,
      x2: x,
      y2: box.y + box.h,
      accent: group.accent ?? false,
    });
  }

  return lines;
}

export function svgDimensions(spec: GraphLayoutSpec) {
  spec = resolveGraphLayout(spec);
  const layout = spec.layout;
  let maxRow = 0;
  let maxCol = 0;
  let maxX = 0;
  let maxY = 0;
  for (const n of spec.nodes) {
    const row = positionedValue(n, 'row');
    const col = positionedValue(n, 'col');
    if (row > maxRow) maxRow = row;
    const lastCol = col + (n.colSpan ?? 1) - 1;
    if (lastCol > maxCol) maxCol = lastCol;
  }
  for (const g of spec.groups ?? []) {
    const bounds = requireGroupBounds(g);
    if (bounds.rowEnd > maxRow) maxRow = bounds.rowEnd;
    if (bounds.colEnd > maxCol) maxCol = bounds.colEnd;
  }
  for (const edge of spec.edges) {
    for (const point of resolveEdgeWaypoints(edge.waypoints, spec)) {
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }
  for (const annotation of resolveGraphAnnotations(spec)) {
    const bounds = annotationTextBounds(annotation);
    if (bounds.x + bounds.w > maxX) maxX = bounds.x + bounds.w;
    if (bounds.y + bounds.h > maxY) maxY = bounds.y + bounds.h;
    for (const point of annotationLeaderBoundaryPoints(annotation)) {
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }
  const resolved = graphLayout(layout);
  const gridW = resolved.padX * 2 + trackPosition('col', maxCol + 1, layout);
  const gridH =
    resolved.padY * 2 +
    resolved.titleTopPad +
    trackPosition('row', maxRow + 1, layout) +
    GROUP_PAD;
  const w = Math.max(gridW, maxX + resolved.padX);
  const h = Math.max(gridH, maxY + resolved.padY);
  return { w, h };
}

export function graphContentViewBox(
  spec: GraphLayoutSpec,
  routedEdges: RoutedEdge[],
  padding = CONTENT_VIEWBOX_PAD,
): ViewBox {
  spec = resolveGraphLayout(spec);
  const layout = spec.layout;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const includePoint = (point: Point) => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  };
  const includeBox = (box: Box) => {
    includePoint({ x: box.x, y: box.y });
    includePoint({ x: box.x + box.w, y: box.y + box.h });
  };

  for (const node of spec.nodes) {
    if (!node.hidden) {
      const box = nodeBox(node, layout);
      includeBox(nodeVisualBox(node, box));
      const captionBounds = nodeCaptionBounds(node, box);
      if (captionBounds) includeBox(captionBounds);
      for (const port of nodePortPlacements(node, box)) {
        includePoint({ x: port.x, y: port.y });
        includePoint({ x: port.labelX, y: port.labelY });
      }
    }
  }
  for (const group of spec.groups ?? []) {
    const box = groupBox(group, spec.nodes, layout, spec.groups);
    includeBox(box);
    for (const port of groupPortPlacements(group, box)) {
      includePoint({ x: port.x, y: port.y });
      includePoint({ x: port.labelX, y: port.labelY });
    }
    for (const line of groupDividerLines(
      group,
      spec.nodes,
      layout,
      spec.groups,
    )) {
      includePoint({ x: line.x1, y: line.y1 });
      includePoint({ x: line.x2, y: line.y2 });
    }
  }
  for (const routedEdge of routedEdges) {
    for (const point of routedEdge.points) includePoint(point);
    if (routedEdge.labelPlacement) {
      includePoint({
        x: routedEdge.labelPlacement.x,
        y: routedEdge.labelPlacement.y,
      });
      if (routedEdge.edge.label) {
        includeBox(
          edgeLabelFrameBox(routedEdge.edge, routedEdge.labelPlacement),
        );
      }
    }
    if (routedEdge.badgePlacement) {
      includeBox(edgeBadgeBounds(routedEdge.edge, routedEdge.badgePlacement));
    }
  }
  for (const annotation of resolveGraphAnnotations(spec)) {
    includeBox(annotationTextBounds(annotation));
    for (const point of annotationLeaderBoundaryPoints(annotation)) {
      includePoint(point);
    }
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    const { w, h } = svgDimensions(spec);
    return { x: 0, y: 0, w, h };
  }

  const x = Math.floor(minX - padding);
  const y = Math.floor(minY - padding);
  const w = Math.ceil(maxX - minX + padding * 2);
  const h = Math.ceil(maxY - minY + padding * 2);
  return { x, y, w, h };
}

function portPlacements(
  ownerId: string,
  ports: DiagramNodePort[] | undefined,
  box: Box,
): PortPlacement[] {
  return (ports ?? []).map((port) => {
    const point = pointOnBoxSide(box, port.side, port.offset ?? 0);
    const labelGap = 10;
    if (port.side === 'left') {
      return {
        ...port,
        ownerId,
        x: point.x,
        y: point.y,
        labelX: point.x - labelGap,
        labelY: point.y + 4,
        labelAlign: 'end',
      };
    }
    if (port.side === 'right') {
      return {
        ...port,
        ownerId,
        x: point.x,
        y: point.y,
        labelX: point.x + labelGap,
        labelY: point.y + 4,
        labelAlign: 'start',
      };
    }
    if (port.side === 'top') {
      return {
        ...port,
        ownerId,
        x: point.x,
        y: point.y,
        labelX: point.x,
        labelY: point.y - 8,
        labelAlign: 'middle',
      };
    }
    return {
      ...port,
      ownerId,
      x: point.x,
      y: point.y,
      labelX: point.x,
      labelY: point.y + 18,
      labelAlign: 'middle',
    };
  });
}

export function nodePortPlacements(
  node: DiagramNode,
  box = nodeBox(node),
): PortPlacement[] {
  return portPlacements(node.id, node.ports, box);
}

export function groupPortPlacements(
  group: DiagramGroup,
  box = groupBox(group),
): PortPlacement[] {
  return portPlacements(group.id, group.ports, box);
}

export function resolveGraphAnnotations(
  spec: GraphLayoutSpec,
): ResolvedDiagramAnnotation[] {
  return (spec.annotations ?? []).map((annotation) =>
    resolveGraphAnnotation(annotation, spec),
  );
}

export function resolveGraphAnnotation(
  annotation: DiagramAnnotation,
  spec: GraphLayoutSpec,
): ResolvedDiagramAnnotation {
  if (annotation.target && annotation.targets !== undefined) {
    throw new Error('Diagram.Text accepts either target or targets, not both.');
  }

  if (annotation.targets !== undefined && annotation.targets.length === 0) {
    throw new Error('Diagram.Text targets must include at least one id.');
  }

  if (annotation.guide && !annotation.target && !annotation.targets?.length) {
    throw new Error(
      `Diagram.Text guide "${annotation.guide}" needs a target node/group id to place a lane callout.`,
    );
  }

  if (annotation.targets?.length) {
    const targetBoxes = annotation.targets.map((target) => ({
      target,
      box: targetBoxForAnnotation(target, spec),
    }));
    const targetBox = unionBoxes(targetBoxes.map(({ box }) => box));
    const anchor = annotation.anchor ?? 'top';
    const point = annotation.guide
      ? annotationGuidePoint(annotation.guide, targetBox, anchor, spec)
      : anchorPoint(targetBox, anchor, annotation.offset ?? 16);
    const resolvedPoint = {
      x: point.x + (annotation.dx ?? 0),
      y: point.y + (annotation.dy ?? 0),
    };
    const leaders = annotation.leader
      ? targetBoxes.map(({ target, box }) => {
          const leader = annotationLeaderPoints(
            annotation,
            box,
            anchor,
            resolvedPoint,
          );
          return {
            target,
            anchor,
            ...leader,
          };
        })
      : undefined;
    return {
      ...annotation,
      x: resolvedPoint.x,
      y: resolvedPoint.y,
      align: annotation.align ?? defaultAnnotationAlign(anchor),
      leaders,
    };
  }

  if (annotation.target) {
    const targetBox = targetBoxForAnnotation(annotation.target, spec);
    const anchor = annotation.anchor ?? 'top';
    const point = annotation.guide
      ? annotationGuidePoint(annotation.guide, targetBox, anchor, spec)
      : anchorPoint(targetBox, anchor, annotation.offset ?? 16);
    const resolvedPoint = {
      x: point.x + (annotation.dx ?? 0),
      y: point.y + (annotation.dy ?? 0),
    };
    const leader = annotation.leader
      ? annotationLeaderPoints(annotation, targetBox, anchor, resolvedPoint)
      : null;
    return {
      ...annotation,
      x: resolvedPoint.x,
      y: resolvedPoint.y,
      align: annotation.align ?? defaultAnnotationAlign(anchor),
      leaderFrom: leader?.from,
      leaderTo: leader?.to,
      leaders: leader
        ? [
            {
              target: annotation.target,
              anchor,
              ...leader,
            },
          ]
        : undefined,
    };
  }

  if (annotation.x === undefined || annotation.y === undefined) {
    throw new Error(
      'Diagram.Text needs x/y coordinates or a target node/group id.',
    );
  }

  return {
    ...annotation,
    x: annotation.x,
    y: annotation.y,
  };
}

function annotationGuidePoint(
  guideId: string,
  targetBox: Box,
  anchor: NonNullable<DiagramAnnotation['anchor']>,
  spec: GraphLayoutSpec,
): Point {
  const guide = guideForId(guideId, spec, 'Diagram.Text');
  const line = resolveGuideLine(guide, spec, 'Diagram.Text');
  const targetPoint = anchorPoint(targetBox, anchor, 0);
  if (line.orientation === 'vertical') {
    return { x: line.x, y: targetPoint.y };
  }
  return { x: targetPoint.x, y: line.y };
}

function targetBoxForAnnotation(target: string, spec: GraphLayoutSpec): Box {
  const node = spec.nodes.find((candidate) => candidate.id === target);
  if (node) return nodeBox(node, spec.layout);
  const group = spec.groups?.find((candidate) => candidate.id === target);
  if (group) return groupBox(group, spec.nodes, spec.layout, spec.groups);
  throw new Error(
    `Diagram.Text target "${target}" does not match a node or group.`,
  );
}

function unionBoxes(boxes: Box[]): Box {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.w));
  const maxY = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function anchorPoint(
  box: Box,
  anchor: NonNullable<DiagramAnnotation['anchor']>,
  offset: number,
): Point {
  const centerX = box.x + box.w / 2;
  const centerY = box.y + box.h / 2;
  if (anchor === 'top') return { x: centerX, y: box.y - offset };
  if (anchor === 'bottom') return { x: centerX, y: box.y + box.h + offset };
  if (anchor === 'left') return { x: box.x - offset, y: centerY };
  if (anchor === 'right') return { x: box.x + box.w + offset, y: centerY };
  return { x: centerX, y: centerY };
}

function annotationLeaderPoints(
  annotation: DiagramAnnotation,
  targetBox: Box,
  anchor: NonNullable<DiagramAnnotation['anchor']>,
  textPoint: Point,
): Omit<DiagramAnnotationLeader, 'target' | 'anchor'> {
  const from = anchorPoint(targetBox, anchor, 0);
  const gap = annotation.leaderGap ?? 6;
  const fontSize = annotation.fontSize ?? 11;
  const route = annotation.leaderRoute ?? 'straight';
  const finish = (to: Point) => ({
    route,
    from,
    to,
    points: annotationLeaderRoutePoints(route, anchor, from, to),
  });
  if (anchor === 'right') {
    return finish({ x: textPoint.x - gap, y: textPoint.y });
  }
  if (anchor === 'left') {
    return finish({ x: textPoint.x + gap, y: textPoint.y });
  }
  if (anchor === 'top') {
    return finish({ x: textPoint.x, y: textPoint.y + fontSize + gap });
  }
  if (anchor === 'bottom') {
    return finish({ x: textPoint.x, y: textPoint.y - fontSize - gap });
  }
  return finish(textPoint);
}

function annotationLeaderRoutePoints(
  route: NonNullable<DiagramAnnotation['leaderRoute']>,
  anchor: NonNullable<DiagramAnnotation['anchor']>,
  from: Point,
  to: Point,
): Point[] {
  if (route === 'straight') return [from, to];
  if (anchor === 'center') return [from, to];
  return compactLeaderPoints([from, { x: from.x, y: to.y }, to]);
}

function compactLeaderPoints(points: Point[]): Point[] {
  return points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || previous.x !== point.x || previous.y !== point.y;
  });
}

function defaultAnnotationAlign(
  anchor: NonNullable<DiagramAnnotation['anchor']>,
): NonNullable<DiagramAnnotation['align']> {
  if (anchor === 'left') return 'end';
  if (anchor === 'right') return 'start';
  return 'middle';
}

function annotationTextBounds(annotation: ResolvedDiagramAnnotation): Box {
  const fontSize = annotation.fontSize ?? 11;
  const lineHeight = fontSize + (annotation.lineGap ?? ANNOTATION_LINE_GAP);
  const width = widestLine(annotation.text, fontSize, 'sans');
  const height =
    textLineBox(fontSize, 'sans') +
    Math.max(0, annotation.text.length - 1) * lineHeight;
  const align = annotation.align ?? 'middle';
  let x = annotation.x - width / 2;
  if (align === 'start') x = annotation.x;
  if (align === 'end') x = annotation.x - width;
  return {
    x,
    y: annotation.y - fontSize,
    w: width,
    h: height,
  };
}

function annotationLeaderBoundaryPoints(
  annotation: ResolvedDiagramAnnotation,
): Point[] {
  if (annotation.leaders?.length) {
    return annotation.leaders.flatMap((leader) => leader.points);
  }
  return [annotation.leaderFrom, annotation.leaderTo].filter(
    (point): point is Point => point !== undefined,
  );
}

class MinHeap<T> {
  private data: { item: T; priority: number }[] = [];
  push(item: T, priority: number) {
    this.data.push({ item, priority });
    this.bubbleUp(this.data.length - 1);
  }
  pop(): T | undefined {
    const top = this.data[0];
    if (!top) return undefined;
    const last = this.data.pop();
    if (last && this.data.length > 0) {
      this.data[0] = last;
      this.bubbleDown(0);
    }
    return top.item;
  }
  empty() {
    return this.data.length === 0;
  }
  private bubbleUp(i: number) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const entry = this.data[i];
      const parentEntry = this.data[parent];
      if (!entry || !parentEntry || entry.priority >= parentEntry.priority)
        break;
      this.data[i] = parentEntry;
      this.data[parent] = entry;
      i = parent;
    }
  }
  private bubbleDown(i: number) {
    while (true) {
      const entry = this.data[i];
      if (!entry) break;
      let smallest = i;
      let smallestEntry = entry;
      const left = this.data[2 * i + 1];
      if (left && left.priority < smallestEntry.priority) {
        smallest = 2 * i + 1;
        smallestEntry = left;
      }
      const right = this.data[2 * i + 2];
      if (right && right.priority < smallestEntry.priority) {
        smallest = 2 * i + 2;
        smallestEntry = right;
      }
      if (smallest === i) break;
      this.data[i] = smallestEntry;
      this.data[smallest] = entry;
      i = smallest;
    }
  }
}

function manhattan(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function dirCode(from: Point, to: Point): number {
  if (to.x > from.x) return 0;
  if (to.x < from.x) return 1;
  if (to.y > from.y) return 2;
  return 3;
}

export function snapToGrid(v: number): number {
  return Math.round(v / ROUTE_CELL) * ROUTE_CELL;
}

export function buildObstacles(
  nodes: DiagramNode[],
  gridW: number,
  gridH: number,
  layout?: DiagramGraphLayout,
): Set<number> {
  const blocked = new Set<number>();
  for (const n of nodes) {
    if (n.hidden) continue;
    const b = nodeVisualBox(n, nodeBox(n, layout));
    const x0 = Math.floor((b.x - NODE_PAD) / ROUTE_CELL);
    const y0 = Math.floor((b.y - NODE_PAD) / ROUTE_CELL);
    const x1 = Math.ceil((b.x + b.w + NODE_PAD) / ROUTE_CELL);
    const y1 = Math.ceil((b.y + b.h + NODE_PAD) / ROUTE_CELL);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (x < 0 || x >= gridW || y < 0 || y >= gridH) continue;
        blocked.add(y * gridW + x);
      }
    }
  }
  return blocked;
}

function pickDiagramSidesByGap(
  source: Box,
  target: Box,
): {
  exitSide: DiagramSide;
  entrySide: DiagramSide;
} {
  const tIsRight = target.x >= source.x + source.w;
  const tIsLeft = target.x + target.w <= source.x;
  const tIsBelow = target.y >= source.y + source.h;
  const tIsAbove = target.y + target.h <= source.y;

  const horizontalGap = tIsRight
    ? target.x - (source.x + source.w)
    : tIsLeft
      ? source.x - (target.x + target.w)
      : null;
  const verticalGap = tIsBelow
    ? target.y - (source.y + source.h)
    : tIsAbove
      ? source.y - (target.y + target.h)
      : null;

  const useVertical =
    verticalGap !== null &&
    (horizontalGap === null || verticalGap <= horizontalGap);

  if (useVertical) {
    return tIsBelow
      ? { exitSide: 'bottom', entrySide: 'top' }
      : { exitSide: 'top', entrySide: 'bottom' };
  }
  return tIsRight
    ? { exitSide: 'right', entrySide: 'left' }
    : { exitSide: 'left', entrySide: 'right' };
}

export function endpointsForDiagramSides(
  source: Box,
  target: Box,
  exitSide: DiagramSide,
  entrySide: DiagramSide,
  exitOffset = 0,
  entryOffset = 0,
  entryGap = ENTRY_GAP,
): {
  exit: Point;
  entry: Point;
  exitSide: DiagramSide;
  entrySide: DiagramSide;
} {
  const sCenter = { x: source.x + source.w / 2, y: source.y + source.h / 2 };
  const tCenter = { x: target.x + target.w / 2, y: target.y + target.h / 2 };

  let exit: Point;
  if (exitSide === 'top') {
    exit = { x: snapToGrid(sCenter.x + exitOffset), y: source.y };
  } else if (exitSide === 'bottom') {
    exit = { x: snapToGrid(sCenter.x + exitOffset), y: source.y + source.h };
  } else if (exitSide === 'left') {
    exit = { x: source.x, y: snapToGrid(sCenter.y + exitOffset) };
  } else {
    exit = { x: source.x + source.w, y: snapToGrid(sCenter.y + exitOffset) };
  }

  let entry: Point;
  if (entrySide === 'top') {
    entry = {
      x: snapToGrid(tCenter.x + entryOffset),
      y: target.y - entryGap,
    };
  } else if (entrySide === 'bottom') {
    entry = {
      x: snapToGrid(tCenter.x + entryOffset),
      y: target.y + target.h + entryGap,
    };
  } else if (entrySide === 'left') {
    entry = {
      x: target.x - entryGap,
      y: snapToGrid(tCenter.y + entryOffset),
    };
  } else {
    entry = {
      x: target.x + target.w + entryGap,
      y: snapToGrid(tCenter.y + entryOffset),
    };
  }

  return { exit, entry, exitSide, entrySide };
}

export function pickEndpoints(
  source: Box,
  target: Box,
  hint?: { exitSide?: DiagramSide; entrySide?: DiagramSide },
  exitOffset = 0,
  entryOffset = 0,
  entryGap = ENTRY_GAP,
): {
  exit: Point;
  entry: Point;
  exitSide: DiagramSide;
  entrySide: DiagramSide;
} {
  const sides =
    hint?.exitSide && hint?.entrySide
      ? { exitSide: hint.exitSide, entrySide: hint.entrySide }
      : pickDiagramSidesByGap(source, target);

  return endpointsForDiagramSides(
    source,
    target,
    sides.exitSide,
    sides.entrySide,
    exitOffset,
    entryOffset,
    entryGap,
  );
}

export function computeStub(
  point: Point,
  side: DiagramSide,
  distance = STUB,
): Point {
  if (side === 'top') return { x: point.x, y: point.y - distance };
  if (side === 'bottom') return { x: point.x, y: point.y + distance };
  if (side === 'left') return { x: point.x - distance, y: point.y };
  return { x: point.x + distance, y: point.y };
}

function tryStraightLine(
  from: Point,
  to: Point,
  blocked: Set<number>,
  gridW: number,
): boolean {
  if (from.x === to.x) {
    const x = Math.round(from.x / ROUTE_CELL);
    const y0 = Math.min(from.y, to.y);
    const y1 = Math.max(from.y, to.y);
    for (let y = y0; y <= y1; y += ROUTE_CELL) {
      const gy = Math.round(y / ROUTE_CELL);
      if (blocked.has(gy * gridW + x)) return false;
    }
    return true;
  }
  if (from.y === to.y) {
    const y = Math.round(from.y / ROUTE_CELL);
    const x0 = Math.min(from.x, to.x);
    const x1 = Math.max(from.x, to.x);
    for (let x = x0; x <= x1; x += ROUTE_CELL) {
      const gx = Math.round(x / ROUTE_CELL);
      if (blocked.has(y * gridW + gx)) return false;
    }
    return true;
  }
  return false;
}

function reserveRoutedEdge(
  blocked: Set<number>,
  points: Point[],
  gridW: number,
  gridH: number,
) {
  if (points.length < 2) return;
  for (let i = 0; i < points.length - 1; i++) {
    const isEndpointStub =
      points.length > 2 && (i === 0 || i === points.length - 2);
    const from = points[i];
    const to = points[i + 1];
    if (isEndpointStub || !from || !to) continue;
    reserveSegment(blocked, from, to, gridW, gridH);
  }
}

function reserveSegment(
  blocked: Set<number>,
  from: Point,
  to: Point,
  gridW: number,
  gridH: number,
) {
  if (from.x !== to.x && from.y !== to.y) return;
  const x0 = Math.round(Math.min(from.x, to.x) / ROUTE_CELL);
  const x1 = Math.round(Math.max(from.x, to.x) / ROUTE_CELL);
  const y0 = Math.round(Math.min(from.y, to.y) / ROUTE_CELL);
  const y1 = Math.round(Math.max(from.y, to.y) / ROUTE_CELL);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      for (
        let dy = -ROUTE_RESERVATION_CELLS;
        dy <= ROUTE_RESERVATION_CELLS;
        dy++
      ) {
        for (
          let dx = -ROUTE_RESERVATION_CELLS;
          dx <= ROUTE_RESERVATION_CELLS;
          dx++
        ) {
          const gx = x + dx;
          const gy = y + dy;
          if (gx < 0 || gx >= gridW || gy < 0 || gy >= gridH) continue;
          blocked.add(gy * gridW + gx);
        }
      }
    }
  }
}

function aStar(
  start: Point,
  goal: Point,
  blocked: Set<number>,
  gridW: number,
  gridH: number,
): Point[] | null {
  const startKey = start.y * gridW + start.x;
  const goalKey = goal.y * gridW + goal.x;
  if (startKey === goalKey) return [start];

  type Node = { pt: Point; dir: number | null };
  const open = new MinHeap<Node>();
  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, Point>();

  gScore.set(startKey, 0);
  open.push({ pt: start, dir: null }, manhattan(start, goal));

  const DIRS: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  while (!open.empty()) {
    const current = open.pop();
    if (!current) break;
    const cur = current.pt;
    const curKey = cur.y * gridW + cur.x;
    if (curKey === goalKey) {
      const path: Point[] = [cur];
      let k = curKey;
      while (cameFrom.has(k)) {
        const prev = cameFrom.get(k);
        if (!prev) break;
        path.unshift(prev);
        k = prev.y * gridW + prev.x;
      }
      return path;
    }

    const lastDir = current.dir;

    for (const [dx, dy] of DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
      const nKey = ny * gridW + nx;
      if (blocked.has(nKey) && nKey !== goalKey) continue;
      const newDir = dirCode(cur, { x: nx, y: ny });
      const turnCost =
        lastDir !== null && newDir !== lastDir ? TURN_PENALTY : 0;
      const tentativeG = (gScore.get(curKey) ?? 0) + 1 + turnCost;
      const existingG = gScore.get(nKey);
      if (existingG !== undefined && tentativeG >= existingG) continue;
      gScore.set(nKey, tentativeG);
      cameFrom.set(nKey, cur);
      const f = tentativeG + manhattan({ x: nx, y: ny }, goal);
      open.push({ pt: { x: nx, y: ny }, dir: newDir }, f);
    }
  }
  return null;
}

export function simplifyPath(path: Point[]): Point[] {
  const first = path[0];
  const last = path.at(-1);
  if (path.length < 3 || !first || !last) return path;
  const result: Point[] = [first];
  let prev = first;
  for (let i = 1; i < path.length - 1; i++) {
    const cur = path[i];
    const next = path[i + 1];
    if (!cur || !next) continue;
    const cross =
      (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
    if (cross === 0) continue;
    result.push(cur);
    prev = cur;
  }
  result.push(last);
  return result;
}

export function pathToSvg(points: Point[], radius = 8): string {
  const [first, second] = points;
  const last = points.at(-1);
  if (!first || !last) return '';
  if (!second) return `M ${first.x} ${first.y}`;
  if (points.length === 2)
    return `M ${first.x} ${first.y} L ${second.x} ${second.y}`;

  const parts = [`M ${first.x} ${first.y}`];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    if (!prev || !cur || !next) continue;
    const dpx = cur.x - prev.x;
    const dpy = cur.y - prev.y;
    const dnx = next.x - cur.x;
    const dny = next.y - cur.y;
    const lp = Math.hypot(dpx, dpy);
    const ln = Math.hypot(dnx, dny);
    const r = Math.min(radius, lp / 2, ln / 2);
    const cs = {
      x: cur.x - (dpx / lp) * r,
      y: cur.y - (dpy / lp) * r,
    };
    const ce = {
      x: cur.x + (dnx / ln) * r,
      y: cur.y + (dny / ln) * r,
    };
    parts.push(`L ${cs.x} ${cs.y}`);
    parts.push(`Q ${cur.x} ${cur.y} ${ce.x} ${ce.y}`);
  }
  parts.push(`L ${last.x} ${last.y}`);
  return parts.join(' ');
}

export type LabelPlacement = {
  x: number;
  y: number;
  align: NonNullable<DiagramEdge['labelAlign']>;
  side: 'above' | 'below' | 'left' | 'right';
  segmentIndex?: number;
};

export type BadgePlacement = {
  x: number;
  y: number;
  side: 'above' | 'below' | 'left' | 'right';
};

type LabelBounds = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

function computeLabelPlacement(
  points: Point[],
  edge?: DiagramEdge,
): LabelPlacement | null {
  if (points.length < 2) return null;
  if (edge?.labelSegment !== undefined) {
    const segmentIndex = resolveLabelSegmentIndex(edge.labelSegment, points);
    const a = points[segmentIndex];
    const b = points[segmentIndex + 1];
    if (!a || !b) return null;
    return {
      ...edgeLabelPlacementForSegment(a, b, edge),
      segmentIndex,
    };
  }
  if (edge?.labelT !== undefined) {
    const anchor = pathAnchorAtFraction(points, edge.labelT);
    if (!anchor) return null;
    if (edge.labelSide && edge.labelSide !== 'auto') {
      return edgeLabelPlacementFromHint(anchor.point.x, anchor.point.y, edge);
    }
    const isHorizontal = anchor.from.y === anchor.to.y;
    if (isHorizontal) {
      return {
        x: anchor.point.x,
        y: anchor.point.y - 10,
        align: 'middle',
        side: 'above',
      };
    }
    return {
      x: anchor.point.x + 10,
      y: anchor.point.y,
      align: 'start',
      side: 'right',
    };
  }

  let bestI = 0;
  let bestLen = -1;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > bestLen) {
      bestLen = len;
      bestI = i;
    }
  }
  const a = points[bestI];
  const b = points[bestI + 1];
  if (!a || !b) return null;
  return {
    ...edgeLabelPlacementForSegment(a, b, edge),
    segmentIndex: bestI,
  };
}

function resolveLabelSegmentIndex(segment: number, points: Point[]) {
  if (!Number.isInteger(segment) || segment < 0) {
    throw new Error(
      `Diagram edge labelSegment must be a non-negative integer, got ${segment}.`,
    );
  }
  const maxSegment = points.length - 2;
  if (segment > maxSegment) {
    throw new Error(
      `Diagram edge labelSegment ${segment} is outside routed path segments 0-${maxSegment}.`,
    );
  }
  return segment;
}

function edgeLabelPlacementForSegment(
  a: Point,
  b: Point,
  edge?: DiagramEdge,
): LabelPlacement {
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  if (edge?.labelSide && edge.labelSide !== 'auto') {
    return edgeLabelPlacementFromHint(midX, midY, edge);
  }

  const isHorizontal = a.y === b.y;
  if (isHorizontal) {
    return { x: midX, y: midY - 10, align: 'middle', side: 'above' };
  }
  return { x: midX + 10, y: midY, align: 'start', side: 'right' };
}

function computeBadgePlacement(
  points: Point[],
  edge: DiagramEdge,
): BadgePlacement | null {
  if (!edge.badgeIcon && !edge.badgeLabel?.length) return null;
  const anchor = pointAtPathFraction(points, edge.badgeT ?? 0.5);
  if (!anchor) return null;
  const side =
    edge.badgeSide && edge.badgeSide !== 'auto' ? edge.badgeSide : 'above';
  const offset = edge.badgeOffset ?? 22;
  const dx = edge.badgeDx ?? 0;
  const dy = edge.badgeDy ?? 0;

  if (side === 'above') {
    return { x: anchor.x + dx, y: anchor.y - offset + dy, side };
  }
  if (side === 'below') {
    return { x: anchor.x + dx, y: anchor.y + offset + dy, side };
  }
  if (side === 'left') {
    return { x: anchor.x - offset + dx, y: anchor.y + dy, side };
  }
  return { x: anchor.x + offset + dx, y: anchor.y + dy, side };
}

function pointAtPathFraction(points: Point[], fraction: number): Point | null {
  return pathAnchorAtFraction(points, fraction)?.point ?? null;
}

function pathAnchorAtFraction(
  points: Point[],
  fraction: number,
): { point: Point; from: Point; to: Point } | null {
  const first = points[0];
  const last = points.at(-1);
  const beforeLast = points.at(-2);
  if (!first || !last) return null;
  if (!beforeLast) {
    return { point: first, from: first, to: first };
  }
  const clamped = Math.max(0, Math.min(1, fraction));
  const segments: { from: Point; to: Point; length: number }[] = [];
  let from = first;
  for (const to of points.slice(1)) {
    segments.push({
      from,
      to,
      length: Math.hypot(to.x - from.x, to.y - from.y),
    });
    from = to;
  }
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (total === 0) {
    return { point: first, from: first, to: first };
  }
  let target = total * clamped;
  for (const segment of segments) {
    if (target > segment.length) {
      target -= segment.length;
      continue;
    }
    const ratio = segment.length === 0 ? 0 : target / segment.length;
    return {
      point: {
        x: segment.from.x + (segment.to.x - segment.from.x) * ratio,
        y: segment.from.y + (segment.to.y - segment.from.y) * ratio,
      },
      from: segment.from,
      to: segment.to,
    };
  }
  return {
    point: last,
    from: beforeLast,
    to: last,
  };
}

function edgeLabelPlacementFromHint(
  midX: number,
  midY: number,
  edge: DiagramEdge,
): LabelPlacement {
  const side = edge.labelSide;
  if (!side || side === 'auto') {
    throw new Error('Diagram edge label side must be resolved before use.');
  }
  const offset = edge.labelOffset ?? 10;
  const dx = edge.labelDx ?? 0;
  const dy = edge.labelDy ?? 0;
  const align =
    edge.labelAlign ??
    (side === 'left' ? 'end' : side === 'right' ? 'start' : 'middle');

  if (side === 'above') {
    return { x: midX + dx, y: midY - offset + dy, align, side };
  }
  if (side === 'below') {
    return { x: midX + dx, y: midY + offset + dy, align, side };
  }
  if (side === 'left') {
    return { x: midX - offset + dx, y: midY + dy, align, side };
  }
  return { x: midX + offset + dx, y: midY + dy, align, side };
}

function deconflictLabelPlacements(routedEdges: RoutedEdge[]): RoutedEdge[] {
  const occupied: LabelBounds[] = [];
  return routedEdges.map((routedEdge) => {
    const placement = routedEdge.labelPlacement;
    const label = routedEdge.edge.label;
    if (!placement || !label?.length) return routedEdge;

    const nextPlacement = placeLabel(placement, routedEdge.edge, occupied);
    occupied.push(edgeLabelBounds(routedEdge.edge, nextPlacement));
    if (nextPlacement === placement) return routedEdge;
    return {
      ...routedEdge,
      labelPlacement: nextPlacement,
    };
  });
}

function placeLabel(
  placement: LabelPlacement,
  edge: DiagramEdge,
  occupied: LabelBounds[],
): LabelPlacement {
  const maxAttempts = Math.max(12, occupied.length * 2 + 8);
  for (const offset of labelOffsetCandidates(placement, edge, maxAttempts)) {
    const candidate = offsetLabelPlacement(placement, offset);
    const bounds = edgeLabelBounds(edge, candidate);
    if (!occupied.some((other) => labelBoundsOverlap(bounds, other))) {
      return candidate;
    }
  }

  throw new Error(
    'Diagram edge labels could not be placed without overlap. Add waypoints or split the diagram.',
  );
}

function labelOffsetCandidates(
  placement: LabelPlacement,
  edge: DiagramEdge,
  maxAttempts: number,
): Point[] {
  const size = edgeLabelSize(edge);
  const step =
    placement.side === 'above' || placement.side === 'below'
      ? size.h + EDGE_LABEL_GAP
      : size.w + EDGE_LABEL_GAP;
  const candidates: Point[] = [{ x: 0, y: 0 }];

  for (let i = 1; candidates.length < maxAttempts; i++) {
    const primary = i * step;
    if (placement.side === 'above') {
      candidates.push({ x: 0, y: -primary }, { x: 0, y: primary });
    } else if (placement.side === 'below') {
      candidates.push({ x: 0, y: primary }, { x: 0, y: -primary });
    } else if (placement.side === 'left') {
      candidates.push({ x: -primary, y: 0 }, { x: primary, y: 0 });
    } else {
      candidates.push({ x: primary, y: 0 }, { x: -primary, y: 0 });
    }
  }

  return candidates.slice(0, maxAttempts);
}

function offsetLabelPlacement(
  placement: LabelPlacement,
  offset: Point,
): LabelPlacement {
  if (offset.x === 0 && offset.y === 0) return placement;
  return {
    ...placement,
    x: placement.x + offset.x,
    y: placement.y + offset.y,
  };
}

export function edgeLabelFontSize(edge: DiagramEdge) {
  return edge.labelFontSize ?? EDGE_LABEL_FONT_SIZE;
}

export function edgeLabelFramePad(edge: DiagramEdge) {
  return edge.labelFramePadding ?? EDGE_LABEL_BOX_PAD;
}

export function edgeLabelSize(edge: DiagramEdge) {
  const label = edge.label ?? [];
  const pad = edgeLabelFramePad(edge);
  return {
    w: widestLine(label, edgeLabelFontSize(edge), 'mono') + pad * 2,
    h:
      textLineBox(edgeLabelFontSize(edge), 'mono') +
      Math.max(0, label.length - 1) * edgeLabelLineHeight(edge) +
      pad * 2,
  };
}

export function edgeLabelAscent(edge: DiagramEdge) {
  return textAscent(edgeLabelFontSize(edge), 'mono') + edgeLabelFramePad(edge);
}

export function edgeLabelLineHeight(edge: DiagramEdge) {
  return edgeLabelFontSize(edge) + (edge.labelLineGap ?? EDGE_LABEL_LINE_GAP);
}

export function edgeBadgeSize(edge: DiagramEdge) {
  const label = edge.badgeLabel ?? [];
  const labelWidth = widestLine(label, EDGE_BADGE_FONT_SIZE, 'sans');
  const iconWidth = edge.badgeIcon ? EDGE_BADGE_ICON : 0;
  const gap = edge.badgeIcon && label.length > 0 ? 8 : 0;
  return {
    w: Math.max(24, iconWidth + gap + labelWidth) + 16,
    h: Math.max(24, label.length * EDGE_LABEL_LINE_H) + 12,
  };
}

function edgeBadgeBounds(edge: DiagramEdge, placement: BadgePlacement): Box {
  const { w, h } = edgeBadgeSize(edge);
  return {
    x: placement.x - w / 2,
    y: placement.y - h / 2,
    w,
    h,
  };
}

function edgeLabelBounds(
  edge: DiagramEdge,
  placement: LabelPlacement,
): LabelBounds {
  const box = edgeLabelFrameBox(edge, placement);
  return {
    x1: box.x,
    y1: box.y,
    x2: box.x + box.w,
    y2: box.y + box.h,
  };
}

export function edgeLabelFrameBox(
  edge: DiagramEdge,
  placement: LabelPlacement,
): Box {
  const { w, h } = edgeLabelSize(edge);
  const y = placement.y - edgeLabelAscent(edge);
  if (placement.align === 'middle') return { x: placement.x - w / 2, y, w, h };
  if (placement.align === 'end') return { x: placement.x - w, y, w, h };
  return { x: placement.x, y, w, h };
}

function labelBoundsOverlap(a: LabelBounds, b: LabelBounds) {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

function resolveEdgeWaypoints(
  waypoints: DiagramWaypoint[] | undefined,
  spec: GraphLayoutSpec,
): Point[] {
  const layout = spec.layout;
  return (waypoints ?? []).map((waypoint) => {
    if ('guide' in waypoint) return resolveGuideWaypoint(waypoint, spec);
    if ('x' in waypoint && 'y' in waypoint) return waypoint;
    if ('target' in waypoint) {
      const point = targetAnchorPoint(
        waypoint.target,
        waypoint.anchor ?? 'center',
        waypoint.gap ?? 0,
        spec,
      );
      return {
        x: snapToGrid(point.x + (waypoint.dx ?? 0)),
        y: snapToGrid(point.y + (waypoint.dy ?? 0)),
      };
    }
    return {
      x: snapToGrid(
        graphPadX(layout) +
          trackPosition('col', waypoint.col, layout) +
          (waypoint.dx ?? 0),
      ),
      y: snapToGrid(
        graphPadY(layout) +
          trackPosition('row', waypoint.row, layout) +
          (waypoint.dy ?? 0),
      ),
    };
  });
}

type GuideWaypoint = Extract<DiagramWaypoint, { guide: string }>;

type ResolvedGuideLine =
  | { orientation: 'vertical'; x: number }
  | { orientation: 'horizontal'; y: number };

function resolveGuideWaypoint(
  waypoint: GuideWaypoint,
  spec: GraphLayoutSpec,
): Point {
  const guide = guideForId(waypoint.guide, spec, 'Diagram.Waypoint');
  const line = resolveGuideLine(guide, spec, 'Diagram.Waypoint');
  if (line.orientation === 'vertical') {
    return {
      x: snapToGrid(line.x + (waypoint.dx ?? 0)),
      y: snapToGrid(
        guideWaypointCrossAxis('y', waypoint, spec) + (waypoint.dy ?? 0),
      ),
    };
  }
  return {
    x: snapToGrid(
      guideWaypointCrossAxis('x', waypoint, spec) + (waypoint.dx ?? 0),
    ),
    y: snapToGrid(line.y + (waypoint.dy ?? 0)),
  };
}

function guideForId(
  guideId: string,
  spec: GraphLayoutSpec,
  consumer: string,
): DiagramGuide {
  const matches = (spec.guides ?? []).filter(
    (candidate) => candidate.id === guideId,
  );
  const [match, ...duplicates] = matches;
  if (!match) {
    throw new Error(
      `${consumer} guide "${guideId}" does not match a Diagram.Guide id.`,
    );
  }
  if (duplicates.length > 0) {
    throw new Error(`Duplicate Diagram guide id "${guideId}".`);
  }
  return match;
}

function resolveGuideLine(
  guide: DiagramGuide,
  spec: GraphLayoutSpec,
  consumer: string,
): ResolvedGuideLine {
  const orientation = guide.orientation;
  if (!orientation) {
    throw new Error(
      `Diagram.Guide "${guide.id}" needs an orientation before ${consumer} can use it.`,
    );
  }
  if (orientation === 'vertical') {
    return {
      orientation,
      x: resolveGuideMainAxis(guide, orientation, spec),
    };
  }
  return {
    orientation,
    y: resolveGuideMainAxis(guide, orientation, spec),
  };
}

function resolveGuideMainAxis(
  guide: DiagramGuide,
  orientation: DiagramGuideOrientation,
  spec: GraphLayoutSpec,
): number {
  if (orientation === 'vertical') {
    if (guide.x !== undefined) return snapToGrid(guide.x + (guide.dx ?? 0));
    if (guide.col !== undefined) {
      return snapToGrid(
        graphPadX(spec.layout) +
          trackPosition('col', guide.col, spec.layout) +
          (guide.dx ?? 0),
      );
    }
    if (guide.target) {
      const point = targetAnchorPoint(
        guide.target,
        guide.anchor ?? 'center',
        guide.gap ?? 0,
        spec,
      );
      return snapToGrid(point.x + (guide.dx ?? 0));
    }
    throw new Error(
      `Diagram.Guide "${guide.id}" needs x, col, or target to define a vertical corridor.`,
    );
  }

  if (guide.y !== undefined) return snapToGrid(guide.y + (guide.dy ?? 0));
  if (guide.row !== undefined) {
    return snapToGrid(
      graphPadY(spec.layout) +
        trackPosition('row', guide.row, spec.layout) +
        (guide.dy ?? 0),
    );
  }
  if (guide.target) {
    const point = targetAnchorPoint(
      guide.target,
      guide.anchor ?? 'center',
      guide.gap ?? 0,
      spec,
    );
    return snapToGrid(point.y + (guide.dy ?? 0));
  }
  throw new Error(
    `Diagram.Guide "${guide.id}" needs y, row, or target to define a horizontal corridor.`,
  );
}

function guideWaypointCrossAxis(
  axis: 'x' | 'y',
  waypoint: GuideWaypoint,
  spec: GraphLayoutSpec,
) {
  if (axis === 'x') {
    if (waypoint.x !== undefined) return waypoint.x;
    if (waypoint.col !== undefined) {
      return (
        graphPadX(spec.layout) + trackPosition('col', waypoint.col, spec.layout)
      );
    }
    if (waypoint.target) {
      return targetAnchorPoint(
        waypoint.target,
        waypoint.anchor ?? 'center',
        waypoint.gap ?? 0,
        spec,
      ).x;
    }
    throw new Error(
      `Diagram.Waypoint guide "${waypoint.guide}" needs target, x, or col to place a point on a horizontal guide.`,
    );
  }

  if (waypoint.y !== undefined) return waypoint.y;
  if (waypoint.row !== undefined) {
    return (
      graphPadY(spec.layout) + trackPosition('row', waypoint.row, spec.layout)
    );
  }
  if (waypoint.target) {
    return targetAnchorPoint(
      waypoint.target,
      waypoint.anchor ?? 'center',
      waypoint.gap ?? 0,
      spec,
    ).y;
  }
  throw new Error(
    `Diagram.Waypoint guide "${waypoint.guide}" needs target, y, or row to place a point on a vertical guide.`,
  );
}

function targetAnchorPoint(
  target: string,
  anchor: DiagramAnchor,
  gap: number,
  spec: GraphLayoutSpec,
): Point {
  return anchorPoint(targetBoxForWaypoint(target, spec), anchor, gap);
}

function targetBoxForWaypoint(target: string, spec: GraphLayoutSpec): Box {
  const node = spec.nodes.find((candidate) => candidate.id === target);
  if (node) return nodeBox(node, spec.layout);
  const group = spec.groups?.find((candidate) => candidate.id === target);
  if (group) return groupBox(group, spec.nodes, spec.layout, spec.groups);
  throw new Error(
    `Diagram.Waypoint target "${target}" does not match a node or group.`,
  );
}

export function routeEdge(
  edge: DiagramEdge,
  source: Box,
  target: Box,
  blocked: Set<number>,
  gridW: number,
  gridH: number,
  hint?: { exitSide?: DiagramSide; entrySide?: DiagramSide },
  exitOffset = 0,
  entryOffset = 0,
  waypoints?: Point[],
  entryGap = ENTRY_GAP,
  routeOffset = 0,
): {
  d: string;
  entry: Point;
  points: Point[];
  labelPlacement: LabelPlacement | null;
  badgePlacement: BadgePlacement | null;
} {
  const { exit, entry, exitSide, entrySide } = pickEndpoints(
    source,
    target,
    hint,
    exitOffset,
    entryOffset,
    entryGap,
  );
  const stubDistance = (edge.stubDistance ?? STUB) + routeOffset;
  const stubExit = computeStub(exit, exitSide, stubDistance);
  const stubEntry = computeStub(entry, entrySide, stubDistance);

  const staggerLabel = (placement: LabelPlacement | null) => {
    if (!placement) return null;
    if (
      (exitSide === 'top' || exitSide === 'bottom') &&
      (placement.side === 'left' || placement.side === 'right')
    ) {
      return { ...placement, y: placement.y + exitOffset };
    }
    return placement;
  };

  if (edge.route === 'straight') {
    const points = [exit, entry];
    return {
      d: pathToSvg(points),
      entry,
      points,
      labelPlacement: staggerLabel(computeLabelPlacement(points, edge)),
      badgePlacement: computeBadgePlacement(points, edge),
    };
  }

  if (waypoints?.length) {
    const points = simplifyPath([
      exit,
      stubExit,
      ...waypoints,
      stubEntry,
      entry,
    ]);
    return {
      d: pathToSvg(points),
      entry,
      points,
      labelPlacement: staggerLabel(computeLabelPlacement(points, edge)),
      badgePlacement: computeBadgePlacement(points, edge),
    };
  }

  if (tryStraightLine(stubExit, stubEntry, blocked, gridW)) {
    const points = simplifyPath([exit, stubExit, stubEntry, entry]);
    return {
      d: pathToSvg(points),
      entry,
      points,
      labelPlacement: staggerLabel(computeLabelPlacement(points, edge)),
      badgePlacement: computeBadgePlacement(points, edge),
    };
  }

  const startG = {
    x: Math.round(stubExit.x / ROUTE_CELL),
    y: Math.round(stubExit.y / ROUTE_CELL),
  };
  const goalG = {
    x: Math.round(stubEntry.x / ROUTE_CELL),
    y: Math.round(stubEntry.y / ROUTE_CELL),
  };

  const path = aStar(startG, goalG, blocked, gridW, gridH);
  if (!path) {
    const fallback = [exit, entry];
    return {
      d: pathToSvg(fallback),
      entry,
      points: fallback,
      labelPlacement: staggerLabel(computeLabelPlacement(fallback, edge)),
      badgePlacement: computeBadgePlacement(fallback, edge),
    };
  }

  const pixelPath = path.map((p) => ({
    x: p.x * ROUTE_CELL,
    y: p.y * ROUTE_CELL,
  }));

  const fullPath = [exit, ...pixelPath, entry];
  const simplified = simplifyPath(fullPath);
  return {
    d: pathToSvg(simplified),
    entry,
    points: simplified,
    labelPlacement: staggerLabel(computeLabelPlacement(simplified, edge)),
    badgePlacement: computeBadgePlacement(simplified, edge),
  };
}

export function pointOnBoxSide(box: Box, side: DiagramSide, offset = 0): Point {
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  if (side === 'top') return { x: snapToGrid(center.x + offset), y: box.y };
  if (side === 'bottom') {
    return { x: snapToGrid(center.x + offset), y: box.y + box.h };
  }
  if (side === 'left') return { x: box.x, y: snapToGrid(center.y + offset) };
  return { x: box.x + box.w, y: snapToGrid(center.y + offset) };
}

function pointOutsideBoxSide(
  box: Box,
  side: DiagramSide,
  offset = 0,
  gap = ENTRY_GAP,
): Point {
  const point = pointOnBoxSide(box, side, offset);
  if (side === 'top') return { ...point, y: box.y - gap };
  if (side === 'bottom') return { ...point, y: box.y + box.h + gap };
  if (side === 'left') return { ...point, x: box.x - gap };
  return { ...point, x: box.x + box.w + gap };
}

function routeSelfLoop(
  edge: DiagramEdge,
  source: Box,
  side: DiagramSide,
  waypoints?: Point[],
  entryGap = ENTRY_GAP,
): {
  d: string;
  entry: Point;
  points: Point[];
  labelPlacement: LabelPlacement | null;
  badgePlacement: BadgePlacement | null;
} {
  const axisOffset =
    side === 'top' || side === 'bottom' ? SELF_LOOP_OFFSET : -SELF_LOOP_OFFSET;
  const entryAxisOffset = -axisOffset;
  const exit = pointOnBoxSide(source, side, axisOffset);
  const entry = pointOutsideBoxSide(source, side, entryAxisOffset, entryGap);

  let loopPoints: Point[];
  if (waypoints?.length) {
    loopPoints = [exit, computeStub(exit, side), ...waypoints, entry];
  } else if (side === 'top') {
    const y = source.y - SELF_LOOP_DEPTH;
    loopPoints = [exit, { x: exit.x, y }, { x: entry.x, y }, entry];
  } else if (side === 'bottom') {
    const y = source.y + source.h + SELF_LOOP_DEPTH;
    loopPoints = [exit, { x: exit.x, y }, { x: entry.x, y }, entry];
  } else if (side === 'left') {
    const x = source.x - SELF_LOOP_DEPTH;
    loopPoints = [exit, { x, y: exit.y }, { x, y: entry.y }, entry];
  } else {
    const x = source.x + source.w + SELF_LOOP_DEPTH;
    loopPoints = [exit, { x, y: exit.y }, { x, y: entry.y }, entry];
  }

  const points = simplifyPath(loopPoints);
  return {
    d: pathToSvg(points),
    entry,
    points,
    labelPlacement: computeLabelPlacement(points, edge),
    badgePlacement: computeBadgePlacement(points, edge),
  };
}

export type RoutedEdge = {
  edge: DiagramEdge;
  exitSide: DiagramSide;
  entrySide: DiagramSide;
  d: string;
  entry: Point;
  points: Point[];
  labelPlacement: LabelPlacement | null;
  badgePlacement: BadgePlacement | null;
};

function resolveDiagramSides(
  edge: DiagramEdge,
  source: Box,
  target: Box,
  hasReciprocal = false,
): { exitSide: DiagramSide; entrySide: DiagramSide } {
  if (edge.exitSide && edge.entrySide) {
    return { exitSide: edge.exitSide, entrySide: edge.entrySide };
  }
  const edgeIsUnhinted =
    !edge.exitSide && !edge.entrySide && !edge.waypoints?.length;
  if (edgeIsUnhinted && hasReciprocal) {
    const sourceCenter = {
      x: source.x + source.w / 2,
      y: source.y + source.h / 2,
    };
    const targetCenter = {
      x: target.x + target.w / 2,
      y: target.y + target.h / 2,
    };
    const horizontalDelta = targetCenter.x - sourceCenter.x;
    const verticalDelta = targetCenter.y - sourceCenter.y;
    if (Math.abs(horizontalDelta) >= Math.abs(verticalDelta)) {
      return horizontalDelta < 0
        ? { exitSide: 'bottom', entrySide: 'bottom' }
        : { exitSide: 'right', entrySide: 'left' };
    }
    return verticalDelta < 0
      ? { exitSide: 'right', entrySide: 'right' }
      : { exitSide: 'bottom', entrySide: 'top' };
  }
  if (edgeIsUnhinted) {
    const sourceCenter = {
      x: source.x + source.w / 2,
      y: source.y + source.h / 2,
    };
    const targetCenter = {
      x: target.x + target.w / 2,
      y: target.y + target.h / 2,
    };
    const horizontalDelta = targetCenter.x - sourceCenter.x;
    const verticalDelta = targetCenter.y - sourceCenter.y;
    if (horizontalDelta < 0 && verticalDelta === 0) {
      return { exitSide: 'bottom', entrySide: 'bottom' };
    }
    if (horizontalDelta > 0 && horizontalDelta >= Math.abs(verticalDelta)) {
      return { exitSide: 'right', entrySide: 'left' };
    }
  }
  return pickDiagramSidesByGap(source, target);
}

function hasReciprocalEdge(spec: GraphLayoutSpec, edge: DiagramEdge) {
  if (edge.from === edge.to) return false;
  return spec.edges.some((candidate) => {
    return (
      parseEndpointRef(candidate.from).nodeId ===
        parseEndpointRef(edge.to).nodeId &&
      parseEndpointRef(candidate.to).nodeId ===
        parseEndpointRef(edge.from).nodeId
    );
  });
}

function computeParallelOffsets(
  spec: GraphLayoutSpec,
  resolvedSides: { exitSide: DiagramSide; entrySide: DiagramSide }[],
): { exitOffsets: number[]; entryOffsets: number[]; routeOffsets: number[] } {
  const exitOffsets = new Array(spec.edges.length).fill(0);
  const entryOffsets = new Array(spec.edges.length).fill(0);
  const routeOffsets = new Array(spec.edges.length).fill(0);
  const nodesById = new Map(spec.nodes.map((node) => [node.id, node]));
  const nodeBoxes = new Map(
    spec.nodes.map((node) => [node.id, nodeBox(node, spec.layout)]),
  );
  const groupsById = new Map(
    (spec.groups ?? []).map((group) => [group.id, group]),
  );
  const groupBoxes = new Map(
    (spec.groups ?? []).map((group) => [
      group.id,
      groupBox(group, spec.nodes, spec.layout, spec.groups),
    ]),
  );
  const lookup: EndpointLookup = {
    nodesById,
    nodeBoxes,
    groupsById,
    groupBoxes,
  };

  const exitGroups = new Map<string, number[]>();
  const entryGroups = new Map<string, number[]>();
  const sameSideRouteGroups = new Map<string, number[]>();
  const fanOutRouteGroups = new Map<string, number[]>();

  spec.edges.forEach((edge, i) => {
    const sides = resolvedSides[i];
    const sourceEndpoint = resolveEndpoint(edge.from, lookup);
    const targetEndpoint = resolveEndpoint(edge.to, lookup);
    if (!sides || !sourceEndpoint || !targetEndpoint) return;
    const exitKey = `${sourceEndpoint.ref}|${sides.exitSide}`;
    const entryKey = `${targetEndpoint.ref}|${sides.entrySide}`;
    const exitArr = exitGroups.get(exitKey) ?? [];
    exitArr.push(i);
    exitGroups.set(exitKey, exitArr);
    const entryArr = entryGroups.get(entryKey) ?? [];
    entryArr.push(i);
    entryGroups.set(entryKey, entryArr);
    if (edge.from !== edge.to && !edge.waypoints?.length) {
      if (sides.exitSide === sides.entrySide) {
        const routeKey = `${sourceEndpoint.id}|${sides.exitSide}`;
        const routeArr = sameSideRouteGroups.get(routeKey) ?? [];
        routeArr.push(i);
        sameSideRouteGroups.set(routeKey, routeArr);
      } else {
        const routeKey = `${sourceEndpoint.id}|${sides.exitSide}|${sides.entrySide}`;
        const routeArr = fanOutRouteGroups.get(routeKey) ?? [];
        routeArr.push(i);
        fanOutRouteGroups.set(routeKey, routeArr);
      }
    }
  });

  for (const indices of exitGroups.values()) {
    const n = indices.length;
    const first = indices[0];
    if (n <= 1 || first === undefined) continue;
    const edge = spec.edges[first];
    const sides = resolvedSides[first];
    if (!edge || !sides) continue;
    const source = resolveEndpoint(edge.from, lookup);
    const offsets = computeSideOffsets(
      n,
      source?.box,
      sides.exitSide,
      source?.cornerInset,
    );
    indices.forEach((idx, i) => {
      exitOffsets[idx] = offsets[i];
    });
  }
  for (const indices of entryGroups.values()) {
    const n = indices.length;
    const first = indices[0];
    if (n <= 1 || first === undefined) continue;
    const edge = spec.edges[first];
    const sides = resolvedSides[first];
    if (!edge || !sides) continue;
    const target = resolveEndpoint(edge.to, lookup);
    const offsets = computeSideOffsets(
      n,
      target?.box,
      sides.entrySide,
      target?.cornerInset,
    );
    indices.forEach((idx, i) => {
      entryOffsets[idx] = offsets[i];
    });
  }

  for (const indices of sameSideRouteGroups.values()) {
    const n = indices.length;
    if (n <= 1) continue;
    const sorted = indices
      .flatMap((idx) => {
        const edge = spec.edges[idx];
        return edge ? [{ idx, span: edgeGridSpan(edge, nodesById) }] : [];
      })
      .sort((a, b) => a.span - b.span)
      .map(({ idx }) => idx);
    sorted.forEach((idx, i) => {
      routeOffsets[idx] = i * PARALLEL_SPACING;
    });
  }

  for (const indices of fanOutRouteGroups.values()) {
    const routed = indices.flatMap((idx) => {
      const edge = spec.edges[idx];
      const sides = resolvedSides[idx];
      return edge && sides ? [{ idx, edge, sides }] : [];
    });
    const targetIds = new Set(routed.map(({ edge }) => edge.to));
    const n = targetIds.size;
    if (n <= 1) continue;
    const sorted = routed
      .map(({ idx, edge, sides }) => ({
        idx,
        axis: edgeTargetAxisPosition(edge, lookup, sides.exitSide),
      }))
      .sort((a, b) => a.axis - b.axis)
      .map(({ idx }) => idx);
    sorted.forEach((idx, i) => {
      routeOffsets[idx] = i * PARALLEL_SPACING;
    });
  }

  return { exitOffsets, entryOffsets, routeOffsets };
}

function computeSideOffsets(
  count: number,
  box: Box | undefined,
  side: DiagramSide,
  cornerInset = 0,
) {
  const maxIndexOffset = (count - 1) / 2;
  const sideSpan = side === 'top' || side === 'bottom' ? box?.w : box?.h;
  const maxOffset =
    sideSpan === undefined
      ? maxIndexOffset * PARALLEL_SPACING
      : Math.max(0, sideSpan / 2 - cornerInset - ROUTE_CELL);
  const spacing =
    maxIndexOffset === 0
      ? 0
      : Math.min(PARALLEL_SPACING, maxOffset / maxIndexOffset);
  return Array.from({ length: count }, (_, i) => {
    return (i - maxIndexOffset) * spacing;
  });
}

function nodeCornerInset(node: DiagramNode) {
  if (node.frame === 'none') return 0;
  return nodeFrameRadius(node);
}

function edgeGridSpan(edge: DiagramEdge, nodesById: Map<string, DiagramNode>) {
  const source = nodesById.get(parseEndpointRef(edge.from).nodeId);
  const target = nodesById.get(parseEndpointRef(edge.to).nodeId);
  if (!source || !target) {
    return 0;
  }
  return (
    Math.abs(positionedValue(source, 'col') - positionedValue(target, 'col')) +
    Math.abs(positionedValue(source, 'row') - positionedValue(target, 'row'))
  );
}

function edgeTargetAxisPosition(
  edge: DiagramEdge,
  lookup: EndpointLookup,
  exitSide: DiagramSide,
) {
  const target = resolveEndpoint(edge.to, lookup);
  if (!target) return 0;
  const box = target.box;
  if (exitSide === 'top' || exitSide === 'bottom') {
    return box.x + box.w / 2;
  }
  return box.y + box.h / 2;
}

export function computePaths(spec: GraphLayoutSpec): RoutedEdge[] {
  spec = resolveGraphLayout(spec);
  const { w: svgW, h: svgH } = svgDimensions(spec);
  const gridW = Math.ceil(svgW / ROUTE_CELL) + 2;
  const gridH = Math.ceil(svgH / ROUTE_CELL) + 2;

  const nodesById = new Map<string, DiagramNode>();
  const nodeBoxes = new Map<string, Box>();
  for (const n of spec.nodes) {
    nodesById.set(n.id, n);
    nodeBoxes.set(n.id, nodeBox(n, spec.layout));
  }
  const groupsById = new Map(
    (spec.groups ?? []).map((group) => [group.id, group]),
  );
  const groupBoxes = new Map(
    (spec.groups ?? []).map((group) => [
      group.id,
      groupBox(group, spec.nodes, spec.layout, spec.groups),
    ]),
  );
  const lookup: EndpointLookup = {
    nodesById,
    nodeBoxes,
    groupsById,
    groupBoxes,
  };

  const blocked = buildObstacles(spec.nodes, gridW, gridH, spec.layout);

  const resolvedSides = spec.edges.map((edge) => {
    const sourceEndpoint = resolveEndpoint(edge.from, lookup);
    const targetEndpoint = resolveEndpoint(edge.to, lookup);
    if (!sourceEndpoint || !targetEndpoint) {
      return {
        exitSide: 'right',
        entrySide: 'left',
      } satisfies { exitSide: DiagramSide; entrySide: DiagramSide };
    }
    assertConnectableEndpoint(edge, sourceEndpoint, 'source');
    assertConnectableEndpoint(edge, targetEndpoint, 'target');
    const sides = resolveDiagramSides(
      edge,
      sourceEndpoint.box,
      targetEndpoint.box,
      hasReciprocalEdge(spec, edge),
    );
    return {
      exitSide: sourceEndpoint?.port?.side ?? sides.exitSide,
      entrySide: targetEndpoint?.port?.side ?? sides.entrySide,
    };
  });

  const { exitOffsets, entryOffsets, routeOffsets } = computeParallelOffsets(
    spec,
    resolvedSides,
  );

  const routedEdges = spec.edges.map((edge, i) => {
    const sourceEndpoint = resolveEndpoint(edge.from, lookup);
    const targetEndpoint = resolveEndpoint(edge.to, lookup);
    const waypoints = resolveEdgeWaypoints(edge.waypoints, spec);
    const sides = resolvedSides[i];
    const exitOffset = exitOffsets[i];
    const entryOffset = entryOffsets[i];
    if (
      !sourceEndpoint ||
      !targetEndpoint ||
      !sides ||
      exitOffset === undefined ||
      entryOffset === undefined
    ) {
      return {
        edge,
        exitSide: sides?.exitSide ?? 'right',
        entrySide: sides?.entrySide ?? 'left',
        d: '',
        entry: { x: 0, y: 0 },
        points: [],
        labelPlacement: null,
        badgePlacement: null,
      };
    }
    assertConnectableEndpoint(edge, sourceEndpoint, 'source');
    assertConnectableEndpoint(edge, targetEndpoint, 'target');
    if (edge.from === edge.to) {
      const side = edge.exitSide ?? edge.entrySide ?? 'top';
      const result = routeSelfLoop(
        edge,
        sourceEndpoint.box,
        side,
        waypoints,
        edge.entryGap,
      );
      reserveRoutedEdge(blocked, result.points, gridW, gridH);
      return { edge, exitSide: side, entrySide: side, ...result };
    }
    const result = routeEdge(
      edge,
      sourceEndpoint.box,
      targetEndpoint.box,
      blocked,
      gridW,
      gridH,
      {
        exitSide: sides.exitSide,
        entrySide: sides.entrySide,
      },
      (sourceEndpoint?.port?.offset ?? 0) + (edge.exitOffset ?? exitOffset),
      (targetEndpoint?.port?.offset ?? 0) + (edge.entryOffset ?? entryOffset),
      waypoints,
      edge.entryGap,
      routeOffsets[i],
    );
    reserveRoutedEdge(blocked, result.points, gridW, gridH);
    return { edge, ...sides, ...result };
  });

  return deconflictLabelPlacements(routedEdges);
}

function resolveEndpoint(
  ref: string,
  lookup: EndpointLookup,
): EndpointRef | null {
  const { nodeId: id, portId } = parseEndpointRef(ref);
  const node = lookup.nodesById.get(id);
  const group = lookup.groupsById.get(id);
  const box = node ? lookup.nodeBoxes.get(id) : lookup.groupBoxes.get(id);
  const cornerInset = node
    ? nodeCornerInset(node)
    : group && groupCornerInset(group);
  if (cornerInset === undefined || !box) {
    return null;
  }

  const ports = node?.ports ?? group?.ports;
  const port = portId
    ? ports?.find((candidate) => candidate.id === portId)
    : undefined;

  if (portId && !port) {
    throw new Error(
      `Diagram endpoint "${ref}" references missing port "${portId}" on "${id}".`,
    );
  }

  return {
    ref: port ? `${id}:${port.id}` : id,
    id,
    kind: node ? 'node' : 'group',
    box,
    cornerInset,
    connectable: node ? node.connectable !== false : true,
    ...(port ? { port } : {}),
  };
}

function assertConnectableEndpoint(
  edge: DiagramEdge,
  endpoint: EndpointRef,
  role: 'source' | 'target',
) {
  if (endpoint.connectable) return;
  const relation = role === 'source' ? 'start from' : 'end at';
  throw new Error(
    `Diagram edge ${edge.from}->${edge.to} cannot ${relation} non-connectable node "${endpoint.id}". Use Diagram.Label, Diagram.Port, Diagram.Box, or Diagram.Phantom for routed endpoints; Diagram.Float is display-only.`,
  );
}
