import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { Socket } from 'node:net';

import type { AnyHandler } from 'msw';
import { type SetupServer, setupServer } from 'msw/node';

export interface MswInterception extends AsyncDisposable {
  /** For `server.use()` in a part of the test. */
  server: SetupServer;
  /** A clone of each request that the server receives, in the order of arrival. */
  requests: Request[];
  /** Close the server, and wait until each connection that it closed has closed. */
  cleanup: () => Promise<void>;
}

/** Each acquisition owns an msw server that fails each request no handler answers. */
export class Msw {
  intercept(...handlers: AnyHandler[]): MswInterception {
    const server = setupServer(...handlers);
    const requests: Request[] = [];
    server.events.on('request:start', ({ request }) => {
      requests.push(request.clone());
    });
    const closes = new Map<Socket, Promise<void>>();
    const track = (message: unknown) => {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('socket' in message) ||
        !(message.socket instanceof Socket)
      ) {
        return;
      }
      const { socket } = message;
      const { promise, resolve } = Promise.withResolvers<void>();
      closes.set(socket, promise);
      socket.once('close', () => {
        closes.delete(socket);
        resolve();
      });
    };
    subscribe('net.client.socket', track);
    server.listen({ onUnhandledFrame: 'error' });
    const owned = new AsyncDisposableStack();
    owned.defer(async () => {
      unsubscribe('net.client.socket', track);
      server.close();
      await Promise.all(
        [...closes]
          .filter(([socket]) => socket.destroyed)
          .map(([, closed]) => closed),
      );
    });
    const cleanup = () => owned.disposeAsync();

    return { server, requests, cleanup, [Symbol.asyncDispose]: cleanup };
  }
}
