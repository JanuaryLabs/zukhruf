import type {
  Box,
  DiagramGraphIR,
  DiagramSide,
} from '../../model/diagram-ir.ts';
import { parseEndpointRef } from '../../model/endpoint-ref.ts';
import type { CellArea, GridAreas } from './areas.ts';
import type {
  GroupLayout,
  NodeLayout,
  PortLayout,
} from './graph-layout-result.ts';
import { type SidePair, sideLine, sidePairs } from './sides.ts';
import { LAYOUT_TOKENS } from './tokens.ts';

/** A node or group that a connection starts or ends at. */
export type Shape = {
  id: string;
  kind: 'node' | 'junction' | 'group';
  box: Box;
  /** The corner radius, which slots keep clear of. */
  radius: number;
  /** A stack's back frames, which draw as one unit with `box`. */
  frames: Box[];
  ports: PortLayout[];
  /** What a connection may not touch the shape through: its caption. */
  clear: Box[];
  area: CellArea;
};

export type ConnectionEnd = {
  shape: Shape;
  side: DiagramSide;
  port: PortLayout | undefined;
  /** The box whose `side` the end touches: of a stack, the frame that reaches farthest out on that side. */
  face: Box;
};

/** An edge, or the leader from a note to its target: anything the router draws between two shapes. */
export type Connection = {
  /** How errors name it: `edge a→b`, or `note leader "n"→"t"`. */
  name: string;
  /** The index of the edge in the graph, or undefined for a leader. */
  edge: number | undefined;
  from: ConnectionEnd;
  to: ConnectionEnd;
  /** The Manhattan distance between the two cell areas' centres. */
  cellDistance: number;
};

/**
 * Resolves every edge and every note leader to the shapes and sides it may
 * join, in order of preference. A side hint wins over the cells; a port
 * fixes the side; a side that declares ports takes no edge without one. A
 * connection between two shapes with no hint and no port on either end may
 * also take the other side pairs the cells allow, whose sides declare no
 * ports; any other connection has one choice.
 */
export function graphConnections(
  ir: DiagramGraphIR,
  nodes: NodeLayout[],
  groups: GroupLayout[],
  areas: GridAreas,
): Connection[][] {
  const shapes = new Map<string, Shape>();
  for (const { node, box, frames, radius, ports, caption } of nodes) {
    shapes.set(node.id, {
      id: node.id,
      kind: node.kind === 'junction' ? 'junction' : 'node',
      box,
      radius,
      frames,
      ports,
      clear: caption ? [caption.box] : [],
      area: areas.nodes.get(node.id)!,
    });
  }
  for (const [index, { group, rect, ports }] of groups.entries()) {
    shapes.set(group.id, {
      id: group.id,
      kind: 'group',
      box: rect,
      radius: LAYOUT_TOKENS.RADIUS,
      frames: [],
      ports,
      clear: [],
      area: areas.groups[index]!.area,
    });
  }

  const connect = (
    name: string,
    edge: number | undefined,
    fromRef: string,
    toRef: string,
    hints: {
      exitSide?: DiagramSide | undefined;
      entrySide?: DiagramSide | undefined;
    },
  ): Connection[] => {
    const resolve = (ref: string) => {
      const { nodeId, portId } = parseEndpointRef(ref);
      const shape = shapes.get(nodeId);
      if (!shape) {
        throw new Error(
          `Diagram ${name}: "${nodeId}" is not a node or a group.`,
        );
      }
      if (portId === undefined) return { shape, port: undefined };
      const port = shape.ports.find((candidate) => candidate.id === portId);
      if (!port) {
        throw new Error(
          `Diagram ${name}: "${nodeId}" has no port "${portId}".`,
        );
      }
      return { shape, port };
    };
    const from = resolve(fromRef);
    const to = resolve(toRef);
    const a = from.shape.area;
    const b = to.shape.area;
    const [[exitByCells, entryByCells], ...others]: [SidePair, ...SidePair[]] =
      from.shape === to.shape
        ? // A loop has no cell delta to read; it leaves and re-enters the right side.
          [['right', 'right']]
        : sidePairs(a, b);
    const declaresPorts = (shape: Shape, side: DiagramSide) =>
      shape.ports.some((port) => port.side === side);
    const sideEnd = (shape: Shape, side: DiagramSide): ConnectionEnd => ({
      shape,
      side,
      port: undefined,
      face: outermostFace(shape, side),
    });
    const end = (
      { shape, port }: { shape: Shape; port: PortLayout | undefined },
      hint: DiagramSide | undefined,
      byCells: DiagramSide,
      role: 'exitSide' | 'entrySide',
      ref: string,
    ): ConnectionEnd => {
      if (port) {
        if (hint !== undefined && hint !== port.side) {
          throw new Error(
            `Diagram ${name}: ${role} ${hint} contradicts port "${ref}" on side ${port.side}.`,
          );
        }
        return { shape, side: port.side, port, face: shape.box };
      }
      const side = hint ?? byCells;
      if (declaresPorts(shape, side)) {
        throw new Error(
          `Diagram ${shape.kind === 'group' ? 'group' : 'node'} "${shape.id}" side ${side} declares ports; ${name} must use "${shape.id}:<port>".`,
        );
      }
      return sideEnd(shape, side);
    };
    const cellDistance =
      Math.abs(b.row + b.rowSpan / 2 - (a.row + a.rowSpan / 2)) +
      Math.abs(b.col + b.colSpan / 2 - (a.col + a.colSpan / 2));
    const chosen = {
      name,
      edge,
      from: end(from, hints.exitSide, exitByCells, 'exitSide', fromRef),
      to: end(to, hints.entrySide, entryByCells, 'entrySide', toRef),
      cellDistance,
    };
    const free =
      hints.exitSide === undefined &&
      hints.entrySide === undefined &&
      !from.port &&
      !to.port;
    if (!free) return [chosen];
    return [
      chosen,
      ...others
        .filter(
          ([exit, entry]) =>
            !declaresPorts(from.shape, exit) && !declaresPorts(to.shape, entry),
        )
        .map(([exit, entry]) => ({
          name,
          edge,
          from: sideEnd(from.shape, exit),
          to: sideEnd(to.shape, entry),
          cellDistance,
        })),
    ];
  };

  return [
    ...ir.edges.map((edge, index) =>
      connect(`edge ${edge.from}→${edge.to}`, index, edge.from, edge.to, edge),
    ),
    ...ir.nodes.flatMap((node) =>
      node.kind === 'note' && node.target !== undefined
        ? [
            connect(
              `note leader "${node.id}"→"${node.target}"`,
              undefined,
              node.id,
              node.target,
              {},
            ),
          ]
        : [],
    ),
  ];
}

/** The frame of `shape` whose `side` lies farthest out: the front frame, or a stacked back frame. */
function outermostFace(shape: Shape, side: DiagramSide): Box {
  const outward = side === 'bottom' || side === 'right' ? 1 : -1;
  return shape.frames.reduce(
    (best, frame) =>
      sideLine(frame, side) * outward > sideLine(best, side) * outward
        ? frame
        : best,
    shape.box,
  );
}
