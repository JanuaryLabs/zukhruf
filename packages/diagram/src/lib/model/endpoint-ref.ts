/**
 * Reads the `from` or `to` of a `DiagramEdge`: `nodeId`, or `nodeId:portId`
 * for a node port. Only the first `:` splits the ref. Thus `'a:'` gives the
 * port id `''`, and a ref with no `:` gives no port id.
 */
export function parseEndpointRef(ref: string): {
  nodeId: string;
  portId: string | undefined;
} {
  const separator = ref.indexOf(':');
  if (separator === -1) return { nodeId: ref, portId: undefined };
  return {
    nodeId: ref.slice(0, separator),
    portId: ref.slice(separator + 1),
  };
}
