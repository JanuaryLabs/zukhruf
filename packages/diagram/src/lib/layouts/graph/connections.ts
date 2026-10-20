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
import { facingSides } from './sides.ts';
import { LAYOUT_TOKENS } from './tokens.ts';

/** A node or group that a connection starts or ends at. */
export type Shape = {
  id: string;
  kind: 'node' | 'junction' | 'group';
  box: Box;
  /** The corner radius, which slots keep clear of. */
  radius: number;
  ports: PortLayout[];
  /** What a connection may not touch the shape through: its caption. */
  clear: Box[];
  area: CellArea;
};

export type ConnectionEnd = {
  shape: Shape;
  side: DiagramSide;
  port: PortLayout | undefined;
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
 * Resolves every edge and every note leader to the shapes and sides it
 * joins. A side hint wins over the cells; a port fixes the side; a side that
 * declares ports takes no edge without one.
 */
export function graphConnections(
  ir: DiagramGraphIR,
  nodes: NodeLayout[],
  groups: GroupLayout[],
  areas: GridAreas,
): Connection[] {
  const shapes = new Map<string, Shape>();
  for (const { node, box, radius, ports, caption } of nodes) {
    shapes.set(node.id, {
      id: node.id,
      kind: node.kind === 'junction' ? 'junction' : 'node',
      box,
      radius,
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
  ): Connection => {
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
    const [exitByCells, entryByCells] =
      from.shape === to.shape
        ? // A loop has no cell delta to read; it leaves and re-enters the right side.
          (['right', 'right'] as const)
        : facingSides(from.shape.area, to.shape.area);
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
        return { shape, side: port.side, port };
      }
      const side = hint ?? byCells;
      if (shape.ports.some((candidate) => candidate.side === side)) {
        throw new Error(
          `Diagram ${shape.kind === 'group' ? 'group' : 'node'} "${shape.id}" side ${side} declares ports; ${name} must use "${shape.id}:<port>".`,
        );
      }
      return { shape, side, port: undefined };
    };
    const a = from.shape.area;
    const b = to.shape.area;
    return {
      name,
      edge,
      from: end(from, hints.exitSide, exitByCells, 'exitSide', fromRef),
      to: end(to, hints.entrySide, entryByCells, 'entrySide', toRef),
      cellDistance:
        Math.abs(b.row + b.rowSpan / 2 - (a.row + a.rowSpan / 2)) +
        Math.abs(b.col + b.colSpan / 2 - (a.col + a.colSpan / 2)),
    };
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
