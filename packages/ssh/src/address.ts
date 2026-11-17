/** Go's `net.SplitHostPort` for a `host:port` address. The brackets of an IPv6 host are removed. */
export function splitHostPort(address: string): { host: string; port: number } {
  const colon = address.lastIndexOf(':');
  const port = Number(address.slice(colon + 1));
  if (colon < 0 || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError(`ssh: the address ${address} is not host:port`);
  }
  const host = address.slice(0, colon).replace(/^\[(.*)\]$/, '$1');
  return { host, port };
}
