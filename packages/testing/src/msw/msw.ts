import type { AnyHandler } from 'msw';
import { type SetupServer, setupServer } from 'msw/node';

export interface MswInterception extends Disposable {
  /** For `server.use()` in a part of the test. */
  server: SetupServer;
  /** A clone of each request that the server receives, in the order of arrival. */
  requests: Request[];
  /** Close the server. */
  cleanup: () => void;
}

/** Each acquisition owns an msw server that fails each request no handler answers. */
export class Msw {
  intercept(...handlers: AnyHandler[]): MswInterception {
    const server = setupServer(...handlers);
    const requests: Request[] = [];
    server.events.on('request:start', ({ request }) => {
      requests.push(request.clone());
    });
    server.listen({ onUnhandledFrame: 'error' });
    const owned = new DisposableStack();
    owned.defer(() => server.close());
    const cleanup = () => owned.dispose();

    return { server, requests, cleanup, [Symbol.dispose]: cleanup };
  }
}
