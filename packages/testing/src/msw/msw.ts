import { subscribe } from 'node:diagnostics_channel';
import { BlockList, Socket } from 'node:net';

import { Interceptor } from '@mswjs/interceptors';
import { WebSocketInterceptor } from '@mswjs/interceptors/WebSocket';
import { HttpRequestInterceptor } from '@mswjs/interceptors/http';
import type { AnyHandler } from 'msw';
import {
  HandlersController,
  InMemoryHandlersController,
  InterceptorSource,
  type NetworkApi,
  NetworkReadyState,
  defineNetwork,
} from 'msw/experimental';

type MswNetwork = NetworkApi<[InterceptorSource]>;

/** The handlers and the events of one interception. */
export type MswServer = Pick<
  MswNetwork,
  'events' | 'use' | 'resetHandlers' | 'restoreHandlers' | 'listHandlers'
>;

export interface MswInterception extends AsyncDisposable {
  /** For `server.use()` in a part of the test, and for `server.events`. */
  server: MswServer;
  /** A clone of each request that the process sends while the interception is open, in the order of arrival. */
  requests: Request[];
  /** Close the interception, and wait until each connection that the close closed has closed. Rejects with a `NetConnectNotAllowedError` when the interception refused a connection. */
  cleanup: () => Promise<void>;
}

/** The interception refused a connection to an address that is not a loopback address. */
export class NetConnectNotAllowedError extends Error {
  override readonly name = 'NetConnectNotAllowedError';
  readonly code = 'ENETUNREACH';
  /** Each refused `address:port`. */
  readonly hosts: readonly string[];

  constructor(hosts: readonly string[]) {
    super(
      `Disallowed net connect for ${hosts.map((host) => `"${host}"`).join(', ')}`,
    );
    this.hosts = hosts;
  }
}

interface Open {
  handlers: HandlersController;
  server: MswServer;
  /** Each socket of the process that has not emitted `close` yet. */
  sockets: Set<Socket>;
  refused: Set<string>;
}

/** Every address that is not a loopback address. `::/0` would also hold each IPv4 address. */
const notLoopback = new BlockList();
notLoopback.addRange('0.0.0.0', '126.255.255.255', 'ipv4');
notLoopback.addRange('128.0.0.0', '255.255.255.255', 'ipv4');
notLoopback.addSubnet('2000::', 3, 'ipv6');
notLoopback.addSubnet('fc00::', 7, 'ipv6');

/** The handlers of each open interception, the newest interception first. */
class OpenHandlers extends HandlersController {
  readonly #open: readonly Open[];

  constructor(open: readonly Open[]) {
    super();
    this.#open = open;
  }

  protected getState() {
    return this.getInitialState(
      this.#open
        .toReversed()
        .flatMap(({ handlers }) => handlers.currentHandlers()),
    );
  }

  protected setState(): void {}
}

/** The open interceptions of the process, and the one msw network that answers with their handlers. */
class Interceptions {
  static #process: Interceptions | undefined;

  /** The first call starts to refuse each connection of the process to an address that is not a loopback address. */
  static process(): Interceptions {
    Interceptions.#process ??= new Interceptions();
    return Interceptions.#process;
  }

  readonly #open: Open[] = [];
  readonly #network: MswNetwork;

  private constructor() {
    this.#network = defineNetwork({
      sources: [
        new InterceptorSource({
          interceptors: [
            new HttpRequestInterceptor(),
            Interceptor.singleton<WebSocketInterceptor>(WebSocketInterceptor),
          ],
        }),
      ],
      handlers: new OpenHandlers(this.#open),
      onUnhandledFrame: 'error',
      context: { quiet: true },
    });
    this.#network.events.on('*', (event) => {
      for (const { server } of this.#open) {
        server.events.emit(event);
      }
    });
    subscribe('net.client.socket', (message) => {
      this.#guard(message);
    });
  }

  add(interception: Open) {
    this.#open.push(interception);
    if (this.#network.readyState === NetworkReadyState.DISABLED) {
      this.#network.enable();
    }
  }

  async remove(interception: Open) {
    this.#open.splice(this.#open.indexOf(interception), 1);
    if (this.#open.length === 0) {
      await this.#network.disable();
    }
  }

  #guard(message: unknown) {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('socket' in message) ||
      !(message.socket instanceof Socket)
    ) {
      return;
    }
    const { socket } = message;
    Object.assign(socket, { blockList: notLoopback });
    socket.on(
      'connectionAttempt',
      (address: string, port: number, family: 4 | 6) => {
        if (notLoopback.check(address, `ipv${family}`)) {
          this.#refuse(`${address}:${port}`);
        }
      },
    );
    socket.on(
      'connectionAttemptFailed',
      (address: string, port: number, _family: number, error: unknown) => {
        if (
          Error.isError(error) &&
          'code' in error &&
          error.code === 'ERR_IP_BLOCKED'
        ) {
          this.#refuse(`${address}:${port}`);
        }
      },
    );
    for (const { sockets } of this.#open) {
      sockets.add(socket);
      socket.once('close', () => {
        sockets.delete(socket);
      });
    }
  }

  #refuse(host: string) {
    for (const { refused } of this.#open) {
      refused.add(host);
    }
  }
}

/** Each acquisition adds its handlers to the msw network of the process. The network fails each request that no handler of an open interception answers, and each connection to an address that is not a loopback address fails from the first acquisition on. */
export class Msw {
  intercept(...initialHandlers: AnyHandler[]): MswInterception {
    const handlers = new InMemoryHandlersController(initialHandlers);
    const server = defineNetwork({
      sources: [new InterceptorSource({ interceptors: [] })],
      handlers,
    });
    const requests: Request[] = [];
    server.events.on('request:start', ({ request }) => {
      requests.push(request.clone());
    });
    const interception: Open = {
      handlers,
      server,
      sockets: new Set(),
      refused: new Set(),
    };
    const interceptions = Interceptions.process();
    interceptions.add(interception);
    const owned = new AsyncDisposableStack();
    owned.defer(async () => {
      const live = [...interception.sockets].filter(
        (socket) => !socket.destroyed,
      );
      await interceptions.remove(interception);
      await handlers.dispose();
      await Promise.all(
        live
          .filter(
            (socket) => socket.destroyed && interception.sockets.has(socket),
          )
          .map(
            (socket) =>
              new Promise((resolve) => {
                socket.once('close', resolve);
              }),
          ),
      );
      if (interception.refused.size > 0) {
        throw new NetConnectNotAllowedError([...interception.refused]);
      }
    });
    const cleanup = () => owned.disposeAsync();

    return { server, requests, cleanup, [Symbol.asyncDispose]: cleanup };
  }
}
