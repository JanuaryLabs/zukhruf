import type { Box, Point } from '../../model/diagram-ir.ts';
import type {
  EdgeLayout,
  GraphLayout,
  GroupLayout,
  LeaderLayout,
  NodeLayout,
  PortLayout,
  TextRun,
} from './graph-layout-result.ts';
import { pathToSvg } from './path.ts';
import type { RoutedGraph } from './route.ts';

/** How many decimals every coordinate the layout returns keeps. */
const DECIMALS = 2;
const SCALE = 10 ** DECIMALS;

/** The value to DECIMALS decimals; `+ 0` turns a rounded -0 into 0. */
export function round(value: number): number {
  return Math.round(value * SCALE) / SCALE + 0;
}

/**
 * The layout with every coordinate rounded to DECIMALS decimals, and each
 * path drawn through the rounded points. The geometry before it keeps full
 * precision, so the rounding happens once and does not drift.
 */
export function roundLayout(
  layout: Omit<GraphLayout, keyof RoutedGraph> & RoutedGraph,
): GraphLayout {
  return {
    nodes: layout.nodes.map(roundNode),
    groups: layout.groups.map(roundGroup),
    edges: layout.edges.map(roundEdge),
    leaders: layout.leaders.map(roundLeader),
    viewBox: roundBox(layout.viewBox),
  };
}

function roundEdge({
  points,
  label,
  badge,
  ...edge
}: RoutedGraph['edges'][number]): EdgeLayout {
  const rounded = points.map(roundPoint);
  return {
    ...edge,
    points: rounded,
    d: pathToSvg(rounded),
    ...(label && {
      label: { box: roundBox(label.box), text: label.text.map(roundRun) },
    }),
    ...(badge && {
      badge: {
        box: roundBox(badge.box),
        ...(badge.icon && { icon: roundBox(badge.icon) }),
        text: badge.text.map(roundRun),
      },
    }),
  };
}

function roundLeader({
  points,
  ...leader
}: RoutedGraph['leaders'][number]): LeaderLayout {
  const rounded = points.map(roundPoint);
  return { ...leader, points: rounded, d: pathToSvg(rounded) };
}

function roundNode({
  box,
  visual,
  frames,
  icon,
  text,
  bullets,
  contentBox,
  caption,
  ports,
  appliance,
  ...node
}: NodeLayout): NodeLayout {
  return {
    ...node,
    box: roundBox(box),
    visual: roundBox(visual),
    frames: frames.map(roundBox),
    ...(icon && {
      icon: { x: round(icon.x), y: round(icon.y), size: round(icon.size) },
    }),
    text: text.map(roundRun),
    bullets: bullets.map(roundPoint),
    ...(contentBox && { contentBox: roundBox(contentBox) }),
    ...(caption && {
      caption: {
        box: roundBox(caption.box),
        framed: caption.framed,
        text: caption.text.map(roundRun),
      },
    }),
    ports: ports.map(roundPort),
    ...(appliance && {
      appliance: {
        body: appliance.body.map(roundPoint),
        face: roundLine(appliance.face),
        antenna: appliance.antenna.map(roundLine),
        jacks: appliance.jacks.map(roundBox),
      },
    }),
  };
}

function roundGroup({
  rect,
  band,
  separator,
  label,
  dividers,
  ports,
  ...group
}: GroupLayout): GroupLayout {
  return {
    ...group,
    rect: roundBox(rect),
    ...(band && { band: roundBox(band) }),
    ...(separator && { separator: roundLine(separator) }),
    label: label.map(roundRun),
    dividers: dividers.map(roundLine),
    ports: ports.map(roundPort),
  };
}

function roundPort({ point, label, ...port }: PortLayout): PortLayout {
  return {
    ...port,
    point: roundPoint(point),
    ...(label && { label: roundRun(label) }),
  };
}

function roundRun(run: TextRun): TextRun {
  return {
    ...run,
    x: round(run.x),
    y: round(run.y),
    bounds: roundBox(run.bounds),
  };
}

function roundLine([a, b]: [Point, Point]): [Point, Point] {
  return [roundPoint(a), roundPoint(b)];
}

function roundPoint({ x, y }: Point): Point {
  return { x: round(x), y: round(y) };
}

function roundBox({ x, y, w, h }: Box): Box {
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}
