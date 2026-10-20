import type { Box, DiagramGraphIR, Point } from '../../model/diagram-ir.ts';
import type { GridAreas } from './areas.ts';
import { attachConnections } from './attach.ts';
import {
  type Connection,
  type ConnectionEnd,
  graphConnections,
} from './connections.ts';
import type {
  EdgeLayout,
  GroupLayout,
  LeaderLayout,
  NodeLayout,
} from './graph-layout-result.ts';
import { tagPosition } from './labels.ts';
import { measureEdgeBadge, measureEdgeLabel } from './measure.ts';
import { pathToSvg, simplifyPath } from './path.ts';
import { searchRoute } from './route-search.ts';
import { OPPOSITE, OUTWARD } from './sides.ts';
import { LAYOUT_TOKENS } from './tokens.ts';

/** How far around the content a route may detour. */
const ROUTING_MARGIN = 64;
/** How far a route keeps from a node that it does not connect. */
const NODE_CLEARANCE = 8;

type Routed = {
  points: Point[];
  /** The junctions the route ends at: routes that share one may run together into it. */
  junctions: Set<string>;
};

/**
 * Routes every edge and note leader orthogonally, nearest cells first, and
 * places each edge's label and badge before the next edge routes around
 * them. It throws when a route or a label has no room; it never draws a
 * diagonal or straight line through what is in the way.
 */
export function routeGraph(
  ir: DiagramGraphIR,
  nodes: NodeLayout[],
  groups: GroupLayout[],
  areas: GridAreas,
  /** How far beyond the bounding box of its two shapes a route first searches. */
  searchMargin: number,
): { edges: EdgeLayout[]; leaders: LeaderLayout[] } {
  const connections = graphConnections(ir, nodes, groups, areas);
  if (connections.length === 0) return { edges: [], leaders: [] };
  const groupLabels = groups.flatMap(({ group, label }) =>
    label.map((run) => ({
      group: group.id,
      box: inflate(run.bounds, LAYOUT_TOKENS.LABEL_GAP),
    })),
  );
  const attachments = attachConnections(connections, groupLabels);
  const content = union([
    ...nodes.map((nodeLayout) => nodeLayout.visual),
    ...groups.map((groupLayout) => groupLayout.rect),
  ]);
  const bounds = inflate(content, ROUTING_MARGIN);
  const solid = nodes.filter(({ box }) => box.w > 0 && box.h > 0);

  const routed: Routed[] = [];
  const tags: Box[] = [];
  const paths = new Map<Connection, Point[]>();
  const labels = new Map<Connection, Pick<EdgeLayout, 'label' | 'badge'>>();

  const order = connections
    .map((connection, index) => ({ connection, index }))
    .sort(
      (a, b) =>
        Number(a.connection.edge === undefined) -
          Number(b.connection.edge === undefined) ||
        a.connection.cellDistance - b.connection.cellDistance ||
        a.index - b.index,
    );

  for (const { connection, index } of order) {
    const { from, to } = connection;
    const ends = new Set([from.shape.id, to.shape.id]);
    const junctions = new Set(
      [from, to]
        .filter((end) => end.shape.kind === 'junction')
        .map((end) => end.shape.id),
    );
    const walls = [
      ...solid.flatMap(({ node, box, visual, frames, caption }) => {
        if (!ends.has(node.id)) return [inflate(visual, NODE_CLEARANCE)];
        if (node.kind === 'junction') return [];
        // Its own parts, not their bounding box: a caption wider than the frame leaves room beside the frame.
        return [box, ...frames, ...(caption ? [caption.box] : [])];
      }),
      ...groupLabels.flatMap(({ group, box }) =>
        ends.has(group) ? [] : [box],
      ),
      ...tags.map((tag) => inflate(tag, LAYOUT_TOKENS.LABEL_GAP)),
    ];
    const runs = routed
      .filter((route) => !overlaps(route.junctions, junctions))
      .flatMap((route) => segments(route.points));
    const { start, startStub, end, endStub } = attachments[index]!;
    const stubs: [Point, Point][] = [
      [start, startStub],
      [endStub, end],
    ];
    const stubsClear = stubs.every(([a, b]) =>
      walls.every((wall) => !crosses(a, b, wall)),
    );

    const search = (window: Box): Point[] | undefined =>
      searchRoute({
        window,
        lines: {
          x: [startStub.x, endStub.x],
          y: [startStub.y, endStub.y],
        },
        walls,
        runs,
        borders: groups.flatMap(({ rect, band }) =>
          band ? [rect, band] : [rect],
        ),
        start: startStub,
        startHeading: OUTWARD[from.side],
        goal: endStub,
        goalHeading: OUTWARD[OPPOSITE[to.side]],
      });
    const near = intersection(
      inflate(
        union([from.shape.box, to.shape.box, spanOf(startStub, endStub)]),
        searchMargin,
      ),
      bounds,
    );
    const found = stubsClear ? (search(near) ?? search(bounds)) : undefined;
    if (!found) {
      const advice =
        connection.edge === undefined
          ? 'Move the note or its target.'
          : 'Change exitSide/entrySide or move a node.';
      throw new Error(
        `Diagram ${connection.name}: no orthogonal route from ${endName(from)} to ${endName(to)} avoids the nodes and labels. ${advice}`,
      );
    }
    const points = simplifyPath([start, ...found, end]);
    paths.set(connection, points);

    if (connection.edge !== undefined) {
      const edge = ir.edges[connection.edge]!;
      const isFree = (box: Box, ownSegments: boolean) =>
        solid.every(({ visual }) => !intersects(box, visual)) &&
        groups.every(
          ({ rect, band, label }) =>
            !(band && intersects(box, band)) &&
            label.every((run) => !intersects(box, run.bounds)) &&
            !(intersects(box, rect) && !contains(rect, box)),
        ) &&
        tags.every((tag) => !intersects(box, tag)) &&
        [
          ...routed.flatMap((route) => segments(route.points)),
          ...(ownSegments ? segments(points) : []),
        ].every(([a, b]) => !crosses(a, b, box));
      const placed: Pick<EdgeLayout, 'label' | 'badge'> = {};
      if (edge.label?.length) {
        const measured = measureEdgeLabel(edge);
        const box = tagPosition(measured, points, 'beside', (candidate) =>
          isFree(candidate, true),
        );
        if (!box) {
          throw new Error(
            `Diagram ${connection.name}: label "${edge.label.join(' / ')}" (${Math.ceil(measured.w)}×${Math.ceil(measured.h)}) has no free position beside its route.`,
          );
        }
        placed.label = { box, text: measured.place(box) };
        tags.push(box);
      }
      if (edge.badgeIcon || edge.badgeLabel?.length) {
        const measured = measureEdgeBadge(edge);
        const box = tagPosition(measured, points, 'on', (candidate) =>
          isFree(candidate, false),
        );
        if (!box) {
          throw new Error(
            `Diagram ${connection.name}: badge "${(edge.badgeLabel ?? []).join(' / ')}" (${Math.ceil(measured.w)}×${Math.ceil(measured.h)}) has no free position on its route.`,
          );
        }
        placed.badge = { box, ...measured.place(box) };
        tags.push(box);
      }
      labels.set(connection, placed);
    }
    routed.push({ points, junctions });
  }

  const edges: EdgeLayout[] = [];
  const leaders: LeaderLayout[] = [];
  for (const connection of connections) {
    const points = paths.get(connection)!;
    if (connection.edge === undefined) {
      leaders.push({
        note: connection.from.shape.id,
        target: connection.to.shape.id,
        points,
        d: pathToSvg(points),
      });
      continue;
    }
    edges.push({
      edge: ir.edges[connection.edge]!,
      exitSide: connection.from.side,
      entrySide: connection.to.side,
      points,
      d: pathToSvg(points),
      ...labels.get(connection),
    });
  }
  return { edges, leaders };
}

function endName({ shape, side, port }: ConnectionEnd): string {
  if (port) return `port "${shape.id}:${port.id}"`;
  if (shape.kind === 'junction') return `the centre of "${shape.id}"`;
  return `${side} of "${shape.id}"`;
}

function segments(points: Point[]): [Point, Point][] {
  return points.slice(1).map((point, index) => [points[index]!, point]);
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  for (const id of a) if (b.has(id)) return true;
  return false;
}

function spanOf(a: Point, b: Point): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/** Whether the segment enters the box's interior, not only its border. */
function crosses(a: Point, b: Point, box: Box): boolean {
  const span = spanOf(a, b);
  return (
    span.x + span.w > box.x &&
    span.x < box.x + box.w &&
    span.y + span.h > box.y &&
    span.y < box.y + box.h
  );
}

function intersects(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

function inflate(box: Box, by: number): Box {
  return { x: box.x - by, y: box.y - by, w: box.w + 2 * by, h: box.h + 2 * by };
}

function intersection(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    w: Math.min(a.x + a.w, b.x + b.w) - x,
    h: Math.min(a.y + a.h, b.y + b.h) - y,
  };
}

function union(boxes: Box[]): Box {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}
