import { once } from 'node:events';
import { type Socket, createServer } from 'node:net';

/** A server on the socket a store connects to, which a test plays by hand. `onPeer` gets each connection; disposal ends them all. */
export async function standInServer(
  socketPath: string,
  onPeer: (peer: Socket) => void,
) {
  const peers = new Set<Socket>();
  const server = createServer((peer) => {
    peers.add(peer);
    peer.on('error', () => {});
    onPeer(peer);
  });
  server.listen(socketPath);
  await once(server, 'listening');
  return {
    [Symbol.asyncDispose]: async () => {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
