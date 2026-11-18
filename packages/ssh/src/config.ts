/** @zukhruf/ssh/config: the settings of OpenSSH for a destination, through ssh -G. */
import { connect } from 'node:net';

import type { Clock } from '@zukhruf/async';

import type { Client, ClientConfig } from './client.ts';
import { dialHost } from './dial-route.ts';
import { ssh2HostKeyAlgorithms } from './host-key-algorithms.ts';
import { matchPattern } from './match-pattern.ts';
import { type Hop, jumpHostFlags, parseProxyJump } from './proxy-jump.ts';
import { type Environment, Settings } from './ssh-g.ts';

export type { Environment } from './ssh-g.ts';

/** How dial reaches the host. OpenSSH uses one of the three: ProxyJump and ProxyCommand exclude each other. */
export type Route =
  | { readonly kind: 'direct' }
  /** ProxyCommand, with its tokens not yet expanded (ADR 0010). */
  | { readonly kind: 'proxy-command'; readonly command: string }
  /** ProxyJump, in the order of the list. Only the first jump host has a route of its own (ADR 0006). */
  | {
      readonly kind: 'jump';
      readonly jumpHosts: readonly [FirstJumpHost, ...JumpHost[]];
    };

/** The resolved settings of a jump host, by its own ssh -G, with no route: OpenSSH reaches a jump host after the first through the one before it, and reads no ProxyJump or ProxyCommand of its config. A jump host opens no session, so it has no session env and no agent forwarding. */
export type JumpHost = Omit<
  OpenSshConfig,
  'route' | 'setEnv' | 'sendEnv' | 'forwardAgent' | 'dial'
>;

/** The first jump host: the one jump host that follows its own ProxyJump or ProxyCommand. */
export interface FirstJumpHost extends JumpHost {
  readonly route: Route;
}

type ForwardAgent =
  | { readonly kind: 'off' }
  | { readonly kind: 'agent' }
  | { readonly kind: 'socket'; readonly path: string };

/** The settings of OpenSSH for one destination, as ssh -G prints them. */
export class OpenSshConfig {
  readonly destination: string;
  readonly hostname: string;
  readonly port: number;
  readonly user: string;
  readonly hostKeyAlias: string | undefined;
  readonly knownHostsFiles: {
    readonly user: readonly string[];
    readonly global: readonly string[];
  };
  /** ssh -G prints true, false, ask or accept-new: 'yes', 'no', 'ask', 'accept-new'. */
  readonly strictHostKeyChecking: 'yes' | 'ask' | 'accept-new' | 'no';
  readonly hashKnownHosts: boolean;
  /** Without the algorithms that ssh2 does not have. */
  readonly hostKeyAlgorithms: readonly string[];
  /** The agent socket; undefined for IdentityAgent none, or no SSH_AUTH_SOCK. */
  readonly identityAgent: string | undefined;
  /** With ~ expanded from HOME of the environment. */
  readonly identityFiles: readonly string[];
  readonly identitiesOnly: boolean;
  readonly route: Route;
  /** ms; undefined for none. */
  readonly connectTimeout: number | undefined;
  /** undefined when ServerAliveInterval is 0. */
  readonly keepalive:
    { readonly interval: number; readonly countMax: number } | undefined;
  /** undefined for any. */
  readonly addressFamily: 4 | 6 | undefined;
  readonly setEnv: ReadonlyMap<string, string>;
  readonly sendEnv: readonly string[];
  /** ForwardAgent as OpenSSH resolves it: no, yes (the agent at SSH_AUTH_SOCK of the environment), or a socket path (a $NAME value is read from the environment). */
  readonly forwardAgent: ForwardAgent;
  readonly #environment: Environment;
  /** ProxyUseFdpass yes for a ProxyCommand on the route: dial fails (ADR 0010). */
  readonly #proxyUseFdpass: boolean;

  private constructor(
    host: JumpHost,
    route: Route,
    settings: Settings,
    environment: Environment,
    proxyUseFdpass: boolean,
  ) {
    this.destination = host.destination;
    this.hostname = host.hostname;
    this.port = host.port;
    this.user = host.user;
    this.hostKeyAlias = host.hostKeyAlias;
    this.knownHostsFiles = host.knownHostsFiles;
    this.strictHostKeyChecking = host.strictHostKeyChecking;
    this.hashKnownHosts = host.hashKnownHosts;
    this.hostKeyAlgorithms = host.hostKeyAlgorithms;
    this.identityAgent = host.identityAgent;
    this.identityFiles = host.identityFiles;
    this.identitiesOnly = host.identitiesOnly;
    this.route = route;
    this.connectTimeout = host.connectTimeout;
    this.keepalive = host.keepalive;
    this.addressFamily = host.addressFamily;
    this.setEnv = new Map(
      settings.getAll('setenv').map((each) => {
        const equals = each.indexOf('=');
        return [each.slice(0, equals), each.slice(equals + 1)];
      }),
    );
    this.sendEnv = settings.getAll('sendenv');
    this.forwardAgent = OpenSshConfig.#forwardAgent(
      settings.required('forwardagent'),
      environment,
    );
    this.#environment = environment;
    this.#proxyUseFdpass = proxyUseFdpass;
  }

  /** Runs ssh -G <flags> -- <destination> with `environment`, and resolves each jump host of the route with its own ssh -G. */
  static async resolve(
    destination: string,
    options: {
      readonly flags?: readonly string[];
      readonly environment: Environment;
      readonly signal?: AbortSignal;
    },
  ): Promise<OpenSshConfig> {
    const { flags = [], environment, signal } = options;
    const settings = await Settings.resolve(
      flags,
      destination,
      environment,
      signal,
    );
    const resolving: Resolving = { flags, environment, signal, fdpass: [] };
    const route = await resolveRoute(settings, resolving, []);
    return new OpenSshConfig(
      readHost(destination, settings, environment),
      route,
      settings,
      environment,
      resolving.fdpass.length > 0,
    );
  }

  /** Connects by the route, checks the host key under the policy, authenticates with the agent, then the identity files, and sets sessionEnv from setEnv and sendEnv, and agentForwarding from forwardAgent. */
  async dial(options: {
    readonly clock: Clock;
    readonly signal?: AbortSignal;
  }): Promise<Client> {
    if (this.#proxyUseFdpass) {
      throw new Error(
        'ssh: ProxyUseFdpass yes is not supported: node:net cannot receive the socket that the ProxyCommand passes back',
      );
    }
    const agentForwarding = this.#agentForwarding();
    return dialHost(
      this,
      this.route,
      {
        sessionEnv: this.#sessionEnv(),
        ...(agentForwarding && { agentForwarding }),
      },
      {
        clock: options.clock,
        signal: options.signal,
        environment: this.#environment,
      },
    );
  }

  /** The variables of the environment that a SendEnv pattern names, then SetEnv, which wins for the same name: OpenSSH sends SetEnv after them (`client_session2_setup` in clientloop.c of OpenSSH 10.5p1). */
  #sessionEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.#environment)) {
      if (
        value !== undefined &&
        this.sendEnv.some((pattern) => matchPattern(pattern, name))
      ) {
        env[name] = value;
      }
    }
    for (const [name, value] of this.setEnv) env[name] = value;
    return env;
  }

  /** ForwardAgent yes with no SSH_AUTH_SOCK in the environment has no agent to forward. */
  #agentForwarding(): ClientConfig['agentForwarding'] {
    const path = this.#agentSocketPath();
    if (path === undefined) return undefined;
    return async () => connect(path);
  }

  #agentSocketPath(): string | undefined {
    const forwardAgent = this.forwardAgent;
    switch (forwardAgent.kind) {
      case 'socket':
        return forwardAgent.path;
      case 'agent':
        return this.#environment['SSH_AUTH_SOCK'];
      case 'off':
        return undefined;
    }
  }

  /** ssh.c of OpenSSH 10.5p1: a `$NAME` that the environment does not set turns forwarding off. */
  static #forwardAgent(value: string, environment: Environment): ForwardAgent {
    if (value === 'no') return { kind: 'off' };
    if (value === 'yes') return { kind: 'agent' };
    if (!value.startsWith('$')) return { kind: 'socket', path: value };
    const path = environment[value.slice(1)];
    return path === undefined ? { kind: 'off' } : { kind: 'socket', path };
  }
}

interface Resolving {
  readonly flags: readonly string[];
  readonly environment: Environment;
  readonly signal: AbortSignal | undefined;
  /** The ProxyCommand routes whose host sets ProxyUseFdpass yes. */
  readonly fdpass: Route[];
}

/**
 * The route of a host. Each jump host is resolved by its own ssh -G, with the
 * flags that OpenSSH gives the ssh of a jump host. `chain` holds the jump
 * hosts that the first jump hosts before this one were resolved for: one that
 * comes back is a loop that never ends.
 */
async function resolveRoute(
  settings: Settings,
  resolving: Resolving,
  chain: readonly string[],
): Promise<Route> {
  const proxyJump = settings.get('proxyjump');
  if (proxyJump !== undefined) {
    const [first, ...later] = parseProxyJump(proxyJump);
    if (first === undefined) throw new Error('ssh -G printed no jump host');
    const key = JSON.stringify(first);
    if (chain.includes(key)) {
      throw new Error(`jumphost loop via ${first.host}`);
    }
    const [firstJumpHost, ...laterJumpHosts] = await Promise.all([
      resolveJumpHost(first, resolving).then(
        async ({ host, settings: firstSettings }): Promise<FirstJumpHost> => ({
          ...host,
          route: await resolveRoute(firstSettings, resolving, [...chain, key]),
        }),
      ),
      ...later.map(async (hop) => (await resolveJumpHost(hop, resolving)).host),
    ]);
    return { kind: 'jump', jumpHosts: [firstJumpHost, ...laterJumpHosts] };
  }
  // ssh -G prints no proxycommand for ProxyCommand none (CLEAR_ON_NONE in
  // fill_default_options of readconf.c, OpenSSH 9.6p1 and 10.5p1).
  const command = settings.get('proxycommand');
  if (command !== undefined) {
    const route: Route = { kind: 'proxy-command', command };
    if (settings.get('proxyusefdpass') === 'yes') resolving.fdpass.push(route);
    return route;
  }
  return { kind: 'direct' };
}

/** A jump host by its own ssh -G; its settings stay for the route of the first one. */
async function resolveJumpHost(
  hop: Hop,
  resolving: Resolving,
): Promise<{ host: JumpHost; settings: Settings }> {
  const settings = await Settings.resolve(
    jumpHostFlags(hop, resolving.flags),
    hop.host,
    resolving.environment,
    resolving.signal,
  );
  return {
    host: readHost(hop.host, settings, resolving.environment),
    settings,
  };
}

const strictHostKeyChecking = new Map([
  ['true', 'yes'],
  ['false', 'no'],
  ['ask', 'ask'],
  ['accept-new', 'accept-new'],
] as const);

const addressFamily = new Map([
  ['inet', 4],
  ['inet6', 6],
  ['any', undefined],
] as const);

/** The settings of a host that a jump host has too. */
function readHost(
  destination: string,
  settings: Settings,
  environment: Environment,
): JumpHost {
  const offered = settings.required('hostkeyalgorithms').split(',');
  const supported: readonly string[] = ssh2HostKeyAlgorithms;
  return {
    destination,
    hostname: settings.required('hostname'),
    port: Number(settings.required('port')),
    user: settings.required('user'),
    hostKeyAlias: settings.get('hostkeyalias'),
    knownHostsFiles: {
      user: fileList(settings.required('userknownhostsfile')),
      global: fileList(settings.required('globalknownhostsfile')).map((file) =>
        expandTilde(file, environment),
      ),
    },
    strictHostKeyChecking: known(
      strictHostKeyChecking,
      'stricthostkeychecking',
      settings,
    ),
    hashKnownHosts: settings.required('hashknownhosts') === 'yes',
    hostKeyAlgorithms: offered.filter((name) => supported.includes(name)),
    identityAgent: identityAgent(settings.get('identityagent'), environment),
    identityFiles: settings
      .getAll('identityfile')
      .map((file) => expandTilde(file, environment)),
    identitiesOnly: settings.required('identitiesonly') === 'yes',
    connectTimeout: connectTimeout(settings.required('connecttimeout')),
    keepalive: keepalive(
      Number(settings.required('serveraliveinterval')),
      Number(settings.required('serveralivecountmax')),
    ),
    addressFamily: known(addressFamily, 'addressfamily', settings),
  };
}

/** A value of a setting that the package maps; a value that OpenSSH adds later fails, so the package never guesses its meaning. */
function known<T>(
  values: ReadonlyMap<string, T>,
  key: string,
  settings: Settings,
): T {
  const value = settings.required(key);
  for (const [name, mapped] of values) {
    if (name === value) return mapped;
  }
  throw new Error(`ssh -G printed ${key} ${value}, which is not known`);
}

/** UserKnownHostsFile and GlobalKnownHostsFile print their files on one line; `none` is no file. */
function fileList(value: string): string[] {
  return value === 'none' ? [] : value.split(' ');
}

/** ssh -G prints identityfile and globalknownhostsfile with the `~` that ssh expands only later. */
function expandTilde(file: string, environment: Environment): string {
  const home = environment['HOME'];
  if (home === undefined || !file.startsWith('~/')) return file;
  return `${home}${file.slice(1)}`;
}

/** ssh_config(5), IdentityAgent; ssh.c of OpenSSH 10.5p1 reads a `$NAME` value from the environment. ssh -G has checked the name (`parse_agent_path` in readconf.c). */
function identityAgent(
  value: string | undefined,
  environment: Environment,
): string | undefined {
  if (value === undefined || value === 'SSH_AUTH_SOCK') {
    return environment['SSH_AUTH_SOCK'];
  }
  if (value === 'none') return undefined;
  if (value.startsWith('$')) {
    return environment[value.slice(1)];
  }
  return value;
}

/** ConnectTimeout in seconds; `none` and 0 set no limit (`timeout_connect` in OpenSSH's misc.c waits with no limit for 0). */
function connectTimeout(value: string): number | undefined {
  if (value === 'none' || value === '0') return undefined;
  return Number(value) * 1000;
}

function keepalive(
  interval: number,
  countMax: number,
): OpenSshConfig['keepalive'] {
  return interval === 0 ? undefined : { interval: interval * 1000, countMax };
}
