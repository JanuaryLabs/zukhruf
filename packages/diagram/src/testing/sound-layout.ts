import type {
  EdgeLayout,
  GraphLayout,
  GroupLayout,
  NodeLayout,
  TextRun,
} from '../lib/layouts/graph/graph-layout-result.ts';
import { LAYOUT_TOKENS } from '../lib/layouts/graph/tokens.ts';
import type { Box, DiagramSide, Point } from '../lib/model/diagram-ir.ts';
import { parseEndpointRef } from '../lib/model/endpoint-ref.ts';

export type InvariantCode =
  | 'N1'
  | 'N2'
  | 'G1'
  | 'G2'
  | 'G3'
  | 'E1'
  | 'E2'
  | 'E3'
  | 'E4'
  | 'E5'
  | 'L1'
  | 'L2'
  | 'V1';

export type LayoutViolation = {
  invariant: InvariantCode;
  ids: string[];
  message: string;
};

export type SoundLayoutOptions = {
  textInset?: number;
};

/** How many pixels of rounding every comparison forgives. */
const EPSILON = 0.5;
/** How far from its route an edge label may sit. */
const MAX_LABEL_DISTANCE = 12;

/** How far outside its entry side an edge may stop, so its arrow tip ends on the border. */
const ARROW_TIP_GAP = 12;

const OUTWARD: Record<DiagramSide, Point> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export function assertSoundLayout(
  layout: GraphLayout,
  options?: SoundLayoutOptions,
): void {
  const violations = layoutViolations(layout, options);
  if (violations.length === 0) return;
  const lines = violations.map(
    (violation) => `  ${violation.invariant} ${violation.message}`,
  );
  throw new Error(
    `The layout is not sound (${violations.length} violations):\n${lines.join('\n')}`,
  );
}

export function layoutViolations(
  layout: GraphLayout,
  options: SoundLayoutOptions = {},
): LayoutViolation[] {
  const { textInset = 4 } = options;
  const geometry = new Geometry(EPSILON);
  const membership = new Membership(layout);
  const violations: LayoutViolation[] = [];
  const report = (invariant: InvariantCode, ids: string[], message: string) =>
    violations.push({ invariant, ids, message });

  checkNodes(layout, geometry, textInset, report);
  checkGroups(layout, geometry, membership, report);
  checkEdges(layout, geometry, membership, report);
  checkLabels(layout, geometry, report);
  checkViewBox(layout, geometry, report);
  return violations;
}

type Report = (
  invariant: InvariantCode,
  ids: string[],
  message: string,
) => void;

function checkNodes(
  layout: GraphLayout,
  geometry: Geometry,
  textInset: number,
  report: Report,
) {
  const solid = layout.nodes.filter((nodeLayout) =>
    geometry.hasArea(nodeLayout.box),
  );
  for (const [index, a] of solid.entries()) {
    for (const b of solid.slice(index + 1)) {
      const area = geometry.overlapArea(a.visual, b.visual);
      if (area > 0) {
        report(
          'N1',
          [a.node.id, b.node.id],
          `nodes "${a.node.id}" and "${b.node.id}" overlap by ${round(area)}px²`,
        );
      }
    }
  }

  for (const { node, box, text, caption, ports } of solid) {
    const runsOutside = (runs: TextRun[], frame: Box, where: string) => {
      for (const run of runs) {
        if (!geometry.contains(frame, run.bounds)) {
          report(
            'N2',
            [node.id],
            `node "${node.id}" text "${run.text}" lies outside its ${where}`,
          );
        }
      }
    };
    runsOutside(text, geometry.inset(box, textInset), 'box');
    if (caption) runsOutside(caption.text, caption.box, 'caption box');
    runsOutside(
      ports.flatMap((port) => (port.label ? [port.label] : [])),
      box,
      'box',
    );
  }
}

function checkGroups(
  layout: GraphLayout,
  geometry: Geometry,
  membership: Membership,
  report: Report,
) {
  for (const { group, rect, band, label } of layout.groups) {
    const id = group.id;
    for (const member of layout.nodes) {
      if (!geometry.hasArea(member.box)) continue;
      const memberId = member.node.id;
      if (membership.isMember(member, id)) {
        if (!geometry.contains(rect, member.visual)) {
          report(
            'G1',
            [id, memberId],
            `group "${id}" does not contain its node "${memberId}"`,
          );
        }
        if (band && geometry.intersects(member.visual, band)) {
          report(
            'G1',
            [id, memberId],
            `node "${memberId}" covers the title band of group "${id}"`,
          );
        }
      } else if (geometry.intersects(member.visual, rect)) {
        report(
          'G3',
          [id, memberId],
          `node "${memberId}" is not in group "${id}" but intersects it`,
        );
      }
    }
    if (band && !geometry.contains(rect, band)) {
      report(
        'G1',
        [id],
        `the title band of group "${id}" lies outside its rect`,
      );
    }
    for (const run of label) {
      if (!geometry.contains(band ?? rect, run.bounds)) {
        report(
          'G1',
          [id],
          `group "${id}" label "${run.text}" lies outside its ${band ? 'band' : 'rect'}`,
        );
      }
    }
  }

  for (const [index, a] of layout.groups.entries()) {
    for (const b of layout.groups.slice(index + 1)) {
      if (
        a.group.parent === b.group.parent &&
        geometry.intersects(a.rect, b.rect)
      ) {
        report(
          'G2',
          [a.group.id, b.group.id],
          `sibling groups "${a.group.id}" and "${b.group.id}" overlap`,
        );
      }
    }
    const parent = membership.group(a.group.parent);
    if (!parent) continue;
    const ids = [parent.group.id, a.group.id];
    if (!geometry.contains(parent.rect, a.rect)) {
      report(
        'G2',
        ids,
        `group "${a.group.id}" lies outside its parent "${parent.group.id}"`,
      );
    }
    if (parent.band && geometry.intersects(a.rect, parent.band)) {
      report(
        'G2',
        ids,
        `group "${a.group.id}" covers the title band of its parent "${parent.group.id}"`,
      );
    }
  }
}

function checkEdges(
  layout: GraphLayout,
  geometry: Geometry,
  membership: Membership,
  report: Report,
) {
  const nodes = new Map(
    layout.nodes.map((nodeLayout) => [nodeLayout.node.id, nodeLayout]),
  );

  const checkPath = (
    id: string,
    what: string,
    points: Point[],
    endpoints: Set<string>,
  ) => {
    if (points.length < 2) {
      report('E1', [id], `${what} has ${points.length} points, fewer than 2`);
      return;
    }
    for (const [a, b] of segments(points)) {
      if (!geometry.isAxisParallel(a, b)) {
        report(
          'E1',
          [id],
          `${what} has a diagonal segment ${formatPoint(a)}→${formatPoint(b)}`,
        );
      }
      for (const other of layout.nodes) {
        if (endpoints.has(other.node.id)) continue;
        if (geometry.segmentCrosses(a, b, other.visual)) {
          report(
            'E2',
            [id, other.node.id],
            `${what} passes through node "${other.node.id}"`,
          );
        }
      }
      for (const { group, label } of layout.groups) {
        if (endpoints.has(group.id)) continue;
        const crossesLabel = label.some((run) =>
          geometry.segmentCrosses(
            a,
            b,
            geometry.inset(run.bounds, -LAYOUT_TOKENS.LABEL_GAP),
          ),
        );
        if (crossesLabel) {
          report(
            'E3',
            [id, group.id],
            `${what} passes through the label of group "${group.id}"`,
          );
        }
      }
    }
  };

  for (const [index, edge] of layout.edges.entries()) {
    const id = edgeId(edge.edge, index);
    const what = `edge "${id}"`;
    const source = parseEndpointRef(edge.edge.from);
    const target = parseEndpointRef(edge.edge.to);
    checkPath(id, what, edge.points, new Set([source.nodeId, target.nodeId]));
    if (edge.points.length < 2) continue;

    const ends = [
      { ref: source, side: edge.exitSide, at: 0, gap: 0, role: 'starts' },
      {
        ref: target,
        side: edge.entrySide,
        at: edge.points.length - 1,
        gap: ARROW_TIP_GAP,
        role: 'ends',
      },
    ] as const;
    for (const { ref, side, at, gap, role } of ends) {
      const point = edge.points[at]!;
      const neighbour = edge.points[at === 0 ? 1 : at - 1]!;
      const node = nodes.get(ref.nodeId);
      if (node?.node.kind === 'junction') {
        if (!geometry.samePoint(point, centre(node.box))) {
          report(
            'E5',
            [id, ref.nodeId],
            `${what} ${role} off the centre of junction "${ref.nodeId}"`,
          );
        }
        continue;
      }
      const anchor = endpointAnchor(
        ref,
        side,
        node,
        membership.group(ref.nodeId),
      );
      if (!anchor) {
        const name =
          ref.portId === undefined ? ref.nodeId : `${ref.nodeId}:${ref.portId}`;
        report(
          'E4',
          [id, ref.nodeId],
          `${what} ${role} at "${name}", which the layout does not hold`,
        );
        continue;
      }
      if (!geometry.onSide(point, anchor, side, gap)) {
        report(
          'E4',
          [id, ref.nodeId],
          `${what} ${role} off the ${side} side of "${ref.nodeId}"`,
        );
      } else if (!geometry.leavesPerpendicular(point, neighbour, side)) {
        report(
          'E4',
          [id, ref.nodeId],
          `${what} ${role} at an angle to the ${side} side of "${ref.nodeId}"`,
        );
      }
    }
  }

  for (const leader of layout.leaders) {
    const id = leaderId(leader);
    checkPath(
      id,
      `leader "${id}"`,
      leader.points,
      new Set([leader.note, leader.target]),
    );
  }
}

/**
 * The box whose side an edge end must lie on. A stack draws as one unit, so
 * its side is the side of the frame that reaches farthest out there.
 */
function endpointAnchor(
  ref: { nodeId: string; portId: string | undefined },
  side: DiagramSide,
  node: NodeLayout | undefined,
  group: GroupLayout | undefined,
): Box | undefined {
  if (ref.portId === undefined) {
    if (!node) return group?.rect;
    const outward = side === 'bottom' || side === 'right' ? 1 : -1;
    return node.frames.reduce(
      (best, frame) =>
        sideCoordinate(frame, side) * outward >
        sideCoordinate(best, side) * outward
          ? frame
          : best,
      node.box,
    );
  }
  const port = (node ?? group)?.ports.find((port) => port.id === ref.portId);
  return port && { ...port.point, w: 0, h: 0 };
}

function checkLabels(layout: GraphLayout, geometry: Geometry, report: Report) {
  const tags: {
    edge: EdgeLayout;
    id: string;
    kind: 'label' | 'badge';
    box: Box;
  }[] = [];
  for (const [index, edge] of layout.edges.entries()) {
    const id = edgeId(edge.edge, index);
    if (edge.label) tags.push({ edge, id, kind: 'label', box: edge.label.box });
    if (edge.badge) tags.push({ edge, id, kind: 'badge', box: edge.badge.box });
  }

  const obstacles: { id: string; what: string; box: Box }[] = [];
  for (const { node, box, visual } of layout.nodes) {
    if (geometry.hasArea(box)) {
      obstacles.push({ id: node.id, what: `node "${node.id}"`, box: visual });
    }
  }
  for (const { node, caption } of layout.nodes) {
    if (caption) {
      obstacles.push({
        id: node.id,
        what: `the caption of node "${node.id}"`,
        box: caption.box,
      });
    }
  }
  for (const { group, band, label } of layout.groups) {
    if (band) {
      obstacles.push({
        id: group.id,
        what: `the title band of group "${group.id}"`,
        box: band,
      });
    }
    for (const run of label) {
      obstacles.push({
        id: group.id,
        what: `the label of group "${group.id}"`,
        box: run.bounds,
      });
    }
  }

  for (const [index, tag] of tags.entries()) {
    const others = tags.slice(index + 1).map((other) => ({
      id: other.id,
      what: `the ${other.kind} of edge "${other.id}"`,
      box: other.box,
    }));
    for (const obstacle of [...obstacles, ...others]) {
      if (geometry.intersects(tag.box, obstacle.box)) {
        report(
          'L1',
          [tag.id, obstacle.id],
          `the ${tag.kind} of edge "${tag.id}" covers ${obstacle.what}`,
        );
      }
    }
    if (tag.kind !== 'label') continue;
    const distance = Math.min(
      ...segments(tag.edge.points).map(([a, b]) =>
        geometry.distance(tag.box, spanOf(a, b)),
      ),
    );
    if (distance > MAX_LABEL_DISTANCE) {
      report(
        'L2',
        [tag.id],
        `the label of edge "${tag.id}" sits ${round(distance)}px from its edge`,
      );
    }
  }
}

function checkViewBox(layout: GraphLayout, geometry: Geometry, report: Report) {
  const { viewBox } = layout;
  const outside = (id: string, what: string, box: Box) => {
    if (!geometry.contains(viewBox, box)) {
      report('V1', [id], `${what} lies outside the viewBox`);
    }
  };
  for (const { node, visual, caption } of layout.nodes) {
    outside(node.id, `node "${node.id}"`, visual);
    if (caption)
      outside(node.id, `the caption of node "${node.id}"`, caption.box);
  }
  for (const { group, rect } of layout.groups) {
    outside(group.id, `group "${group.id}"`, rect);
  }
  for (const [
    index,
    { edge, points, label, badge },
  ] of layout.edges.entries()) {
    const id = edgeId(edge, index);
    for (const point of points)
      outside(id, `a point of edge "${id}"`, spanOf(point, point));
    if (label) outside(id, `the label of edge "${id}"`, label.box);
    if (badge) outside(id, `the badge of edge "${id}"`, badge.box);
  }
  for (const leader of layout.leaders) {
    const id = leaderId(leader);
    for (const point of leader.points)
      outside(id, `a point of leader "${id}"`, spanOf(point, point));
  }
}

class Membership {
  readonly #groups: Map<string, GroupLayout>;

  constructor(layout: GraphLayout) {
    this.#groups = new Map(
      layout.groups.map((groupLayout) => [groupLayout.group.id, groupLayout]),
    );
  }

  group(id: string | undefined): GroupLayout | undefined {
    return id === undefined ? undefined : this.#groups.get(id);
  }

  isMember(nodeLayout: NodeLayout, groupId: string): boolean {
    const seen = new Set<string>();
    for (
      let id = nodeLayout.node.group;
      id !== undefined && !seen.has(id);
      id = this.group(id)?.group.parent
    ) {
      if (id === groupId) return true;
      seen.add(id);
    }
    return false;
  }
}

/** Box arithmetic where every comparison forgives EPSILON pixels of rounding. */
class Geometry {
  readonly #epsilon: number;

  constructor(epsilon: number) {
    this.#epsilon = epsilon;
  }

  hasArea(box: Box): boolean {
    return box.w > this.#epsilon && box.h > this.#epsilon;
  }

  inset(box: Box, by: number): Box {
    return {
      x: box.x + by,
      y: box.y + by,
      w: box.w - 2 * by,
      h: box.h - 2 * by,
    };
  }

  overlapArea(a: Box, b: Box): number {
    const w = overlap(a.x, a.x + a.w, b.x, b.x + b.w);
    const h = overlap(a.y, a.y + a.h, b.y, b.y + b.h);
    return w > this.#epsilon && h > this.#epsilon ? w * h : 0;
  }

  intersects(a: Box, b: Box): boolean {
    return this.overlapArea(a, b) > 0;
  }

  contains(outer: Box, inner: Box): boolean {
    const e = this.#epsilon;
    return (
      inner.x >= outer.x - e &&
      inner.y >= outer.y - e &&
      inner.x + inner.w <= outer.x + outer.w + e &&
      inner.y + inner.h <= outer.y + outer.h + e
    );
  }

  /** Whether the segment enters the box's interior, not only its border. */
  segmentCrosses(a: Point, b: Point, box: Box): boolean {
    if (!this.hasArea(box)) return false;
    const inner = this.inset(box, this.#epsilon);
    const span = spanOf(a, b);
    return (
      span.x + span.w > inner.x &&
      span.x < inner.x + inner.w &&
      span.y + span.h > inner.y &&
      span.y < inner.y + inner.h
    );
  }

  isAxisParallel(a: Point, b: Point): boolean {
    return (
      Math.abs(a.x - b.x) <= this.#epsilon ||
      Math.abs(a.y - b.y) <= this.#epsilon
    );
  }

  samePoint(a: Point, b: Point): boolean {
    return (
      Math.abs(a.x - b.x) <= this.#epsilon &&
      Math.abs(a.y - b.y) <= this.#epsilon
    );
  }

  /** Whether the point lies on that side of the box, or up to `gap` outside it along the side's normal. */
  onSide(point: Point, box: Box, side: DiagramSide, gap: number): boolean {
    const e = this.#epsilon;
    const normal = OUTWARD[side];
    const vertical = normal.x === 0;
    const [along, from, to] = vertical
      ? [point.x, box.x, box.x + box.w]
      : [point.y, box.y, box.y + box.h];
    if (along < from - e || along > to + e) return false;
    const border = sideCoordinate(box, side);
    const offset = vertical
      ? (point.y - border) * normal.y
      : (point.x - border) * normal.x;
    return offset >= -e && offset <= gap + e;
  }

  /** Whether the segment from `point` to `neighbour` heads straight out of that side. */
  leavesPerpendicular(
    point: Point,
    neighbour: Point,
    side: DiagramSide,
  ): boolean {
    const normal = OUTWARD[side];
    const dx = neighbour.x - point.x;
    const dy = neighbour.y - point.y;
    const outward = dx * normal.x + dy * normal.y;
    const sideways = Math.abs(dx * normal.y) + Math.abs(dy * normal.x);
    return outward > this.#epsilon && sideways <= this.#epsilon;
  }

  distance(a: Box, b: Box): number {
    const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
    const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
    return Math.hypot(dx, dy);
  }
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function sideCoordinate(box: Box, side: DiagramSide): number {
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

function spanOf(a: Point, b: Point): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

function centre(box: Box): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function segments(points: Point[]): [Point, Point][] {
  return points.slice(1).map((point, index) => [points[index]!, point]);
}

/** Two edges with the same ends stay apart by their index in the layout. */
function edgeId(edge: { from: string; to: string }, index: number): string {
  return `${edge.from}->${edge.to}#${index}`;
}

function leaderId(leader: { note: string; target: string }): string {
  return `${leader.note}->${leader.target}`;
}

function formatPoint(point: Point): string {
  return `(${round(point.x)},${round(point.y)})`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
