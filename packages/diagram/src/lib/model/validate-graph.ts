import type { DiagramGraphIR } from './diagram-ir.ts';
import { parseEndpointRef } from './endpoint-ref.ts';

/**
 * Rejects ids that clash and edges whose ends name no node, group or port,
 * or a node that takes no edges.
 */
export function validateGraph(ir: DiagramGraphIR) {
  const nodeIds = new Set<string>();
  for (const node of ir.nodes) {
    if (nodeIds.has(node.id))
      throw new Error(`Duplicate Diagram node id "${node.id}".`);
    nodeIds.add(node.id);
  }
  const groupIds = new Set<string>();
  for (const group of ir.groups) {
    if (groupIds.has(group.id))
      throw new Error(`Duplicate Diagram group id "${group.id}".`);
    groupIds.add(group.id);
  }
  const nodesById = new Map(ir.nodes.map((node) => [node.id, node]));
  const groupsById = new Map(ir.groups.map((group) => [group.id, group]));
  for (const node of ir.nodes) {
    if (groupsById.has(node.id)) {
      throw new Error(
        `Diagram node id "${node.id}" conflicts with a Diagram group id. Node and group endpoint ids must be unique.`,
      );
    }
  }
  const hasPort = (ownerId: string, portId: string) =>
    [nodesById.get(ownerId), groupsById.get(ownerId)].some((owner) =>
      owner?.ports?.some((port) => port.id === portId),
    );
  for (const edge of ir.edges) {
    const { nodeId: sourceNodeId, portId: sourcePortId } = parseEndpointRef(
      edge.from,
    );
    const { nodeId: targetNodeId, portId: targetPortId } = parseEndpointRef(
      edge.to,
    );
    if (!nodeIds.has(sourceNodeId) && !groupsById.has(sourceNodeId)) {
      throw new Error(
        `Diagram edge ${edge.from}->${edge.to} references missing source "${sourceNodeId}".`,
      );
    }
    if (!nodeIds.has(targetNodeId) && !groupsById.has(targetNodeId)) {
      throw new Error(
        `Diagram edge ${edge.from}->${edge.to} references missing target "${targetNodeId}".`,
      );
    }
    if (sourcePortId && !hasPort(sourceNodeId, sourcePortId)) {
      throw new Error(
        `Diagram edge ${edge.from}->${edge.to} references missing source port "${sourcePortId}" on "${sourceNodeId}".`,
      );
    }
    if (targetPortId && !hasPort(targetNodeId, targetPortId)) {
      throw new Error(
        `Diagram edge ${edge.from}->${edge.to} references missing target port "${targetPortId}" on "${targetNodeId}".`,
      );
    }
    for (const [relation, id] of [
      ['start from', sourceNodeId],
      ['end at', targetNodeId],
    ] as const) {
      if (nodesById.get(id)?.connectable === false) {
        throw new Error(
          `Diagram edge ${edge.from}->${edge.to} cannot ${relation} non-connectable node "${id}". Diagram.Float is display-only; connect a Box, Card, Label or Port.`,
        );
      }
    }
  }
}
