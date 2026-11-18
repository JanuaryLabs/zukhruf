import type { Duplex } from 'node:stream';

import type { Clock } from '@zukhruf/async';

import { joinHostPort } from './address.ts';
import {
  Client,
  type ClientConfig,
  closeWithClient,
  restrictClient,
} from './client.ts';
import type { JumpHost, Route } from './config.ts';
import { HostKeyPolicy } from './host-key-policy.ts';
import { Identities } from './identities.ts';
import { startProxyCommand } from './proxy-command.ts';
import type { Environment } from './ssh-g.ts';

export interface DialContext {
  readonly clock: Clock;
  readonly signal: AbortSignal | undefined;
  readonly environment: Environment;
}

/** What only the destination has: a jump host opens no session. */
export type SessionSettings = Pick<
  ClientConfig,
  'sessionEnv' | 'agentForwarding'
>;

/** Reaches `host` by `route` (README, "Connect with the settings of OpenSSH"). */
export async function dialHost(
  host: JumpHost,
  route: Route,
  session: SessionSettings,
  context: DialContext,
): Promise<Client> {
  const { signal } = context;
  const address = joinHostPort(host.hostname, host.port);
  switch (route.kind) {
    case 'direct':
      return handshakeHost(host, session, context, (config) =>
        Client.dial(address, config, {
          ...(host.addressFamily && { family: host.addressFamily }),
          ...(signal && { signal }),
        }),
      );
    case 'proxy-command':
      return handshakeHost(host, session, context, (config) =>
        handshakeOn(
          startProxyCommand(route.command, host, context.environment),
          address,
          config,
          signal,
        ),
      );
    case 'jump':
      return dialThroughJumpHosts(host, route, session, context);
  }
}

/**
 * The first jump host by its own route, then each next host through a
 * direct-tcpip channel of the client before it (ADR 0006). Each client owns
 * the one before it, so the close of the destination's client closes the
 * chain from the last jump host back to the first.
 */
async function dialThroughJumpHosts(
  host: JumpHost,
  route: Extract<Route, { kind: 'jump' }>,
  session: SessionSettings,
  context: DialContext,
): Promise<Client> {
  const [first, ...later] = route.jumpHosts;
  const { signal } = context;
  let previous = await dialHost(first, first.route, {}, context);
  try {
    for (const next of [...later, host]) {
      const address = joinHostPort(next.hostname, next.port);
      const channel = await previous.dial('tcp', address, {
        ...(signal && { signal }),
      });
      const client = await handshakeHost(
        next,
        next === host ? session : {},
        context,
        (config) => handshakeOn(channel, address, config, signal),
      );
      closeWithClient(client, previous);
      previous = client;
    }
    return previous;
  } catch (error) {
    await previous.close();
    throw error;
  }
}

/** Client.handshake, which leaves the transport to its caller when it throws before it starts. */
async function handshakeOn(
  transport: Duplex,
  address: string,
  config: ClientConfig,
  signal: AbortSignal | undefined,
): Promise<Client> {
  try {
    return await Client.handshake(transport, address, config, {
      ...(signal && { signal }),
    });
  } catch (error) {
    transport.destroy();
    throw error;
  }
}

/** The handshake of one host: its own known hosts and policy, its own identities, its own timeouts. */
async function handshakeHost(
  host: JumpHost,
  session: SessionSettings,
  context: DialContext,
  open: (config: ClientConfig) => Promise<Client>,
): Promise<Client> {
  const policy = await HostKeyPolicy.read(host);
  await using identities = new Identities(host);
  const client = await open({
    user: host.user,
    auth: [identities.method],
    hostKey: policy.check,
    hostKeyAlgorithms: policy.algorithms(),
    clock: context.clock,
    ...(host.connectTimeout !== undefined && {
      connectTimeout: host.connectTimeout,
    }),
    ...(host.keepalive && { keepalive: host.keepalive }),
    ...session,
  });
  const restriction = await policy.restriction();
  if (restriction !== undefined) restrictClient(client, restriction);
  return client;
}
