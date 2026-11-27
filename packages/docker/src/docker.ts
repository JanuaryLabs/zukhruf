import { type Readable, pipeline } from 'node:stream';

import type { WallClock } from '@zukhruf/async';

import { negotiateApiVersion } from './api-version.ts';
import { Containers } from './containers.ts';
import {
  type DockerContext,
  type Environment,
  listContexts,
  selectEngine,
} from './context-store.ts';
import type * as EngineApi from './engine-api.ts';
import { EngineClient } from './engine-client.ts';
import { parseHost } from './host.ts';
import { Images } from './images.ts';
import { NdjsonDecoder, ndjson } from './ndjson.ts';
import { Networks } from './networks.ts';
import type { CancelOptions, Filters } from './options.ts';
import { SshDialer } from './ssh-engine.ts';
import { SocketDialer, Transport } from './transport.ts';
import { Volumes } from './volumes.ts';

function isEventMessage(value: unknown): value is EngineApi.EventMessage {
  return typeof value === 'object' && value !== null;
}

/**
 * A context or a host, never both. `clock` is the clock of the waits of the
 * client, also of the SSH connection: `globalThis` in production, a fake
 * clock in a test. `sshFlags` are raw flags of `ssh`, which OpenSSH reads
 * before the config file: only an engine at an ssh:// host uses them.
 */
export type ConnectOptions = CancelOptions & {
  environment?: Environment;
  clock: WallClock;
  sshFlags?: readonly string[];
} & ({ context?: string; host?: never } | { host?: string; context?: never });

/** A client of one engine. Dispose it to close its connections. */
export class Docker implements AsyncDisposable {
  /** The context that selected the engine: 'default' for DOCKER_HOST or a host option. */
  readonly context: string;
  readonly host: string;
  readonly apiVersion: string;
  /** Sends the Docker CLI to this engine: { DOCKER_HOST, DOCKER_CONTEXT: undefined }. */
  readonly cliEnvironment: Readonly<Record<string, string | undefined>>;
  readonly containers: Containers;
  readonly volumes: Volumes;
  readonly networks: Networks;
  readonly images: Images;
  readonly #client: EngineClient;

  private constructor(
    context: string,
    host: string,
    apiVersion: string,
    client: EngineClient,
    clock: WallClock,
  ) {
    this.context = context;
    this.host = host;
    this.apiVersion = apiVersion;
    this.cliEnvironment = Object.freeze({
      DOCKER_HOST: host,
      DOCKER_CONTEXT: undefined,
    });
    this.#client = client;
    this.images = new Images(client, clock);
    this.containers = new Containers(client, this.images, clock);
    this.volumes = new Volumes(client);
    this.networks = new Networks(client);
  }

  /** Selects the engine in the order of the Docker CLI, pings it and negotiates the API version. */
  static async connect(options: ConnectOptions): Promise<Docker> {
    const { signal, clock } = options;
    const engine = await selectEngine(options);
    const parsed = parseHost(engine.host);
    const transport = new Transport(
      parsed.kind === 'ssh'
        ? await SshDialer.connect(parsed, options)
        : new SocketDialer(parsed.kind, parsed.socketPath),
    );
    try {
      const unversioned = new EngineClient(engine.host, transport);
      const ping = await unversioned.request('GET', '/_ping', { signal });
      const engineVersion = ping.headers['api-version'];
      const apiVersion = negotiateApiVersion(
        engine.host,
        typeof engineVersion === 'string' ? engineVersion : '',
      );
      return new Docker(
        engine.context,
        engine.host,
        apiVersion,
        unversioned.versioned(apiVersion),
        clock,
      );
    } catch (error) {
      await transport.close();
      throw error;
    }
  }

  /** Each context of the context store, and the default context. */
  static async contexts(
    options: { environment?: Environment } = {},
  ): Promise<DockerContext[]> {
    return listContexts(options.environment);
  }

  async info(options: CancelOptions = {}): Promise<EngineApi.SystemInfo> {
    return this.#client.json<EngineApi.SystemInfo>('GET', '/info', options);
  }

  /**
   * The events of the engine as they happen, on a connection of their own.
   * The iteration ends when the signal aborts, and then it rejects with the
   * reason of the signal. When the connection is lost, it rejects with the
   * error of Node, not with a DockerError: call events() again.
   */
  async *events(
    options: CancelOptions & { since?: number; filters?: Filters } = {},
  ): AsyncIterable<EngineApi.EventMessage> {
    const { since, filters, signal } = options;
    const response = await this.#client.stream('GET', '/events', {
      query: { since, filters },
      signal,
    });
    for await (const event of ndjson(response)) {
      if (isEventMessage(event)) yield event;
    }
  }

  /**
   * A stream of the events of the engine, open when it resolves: a Readable
   * in object mode, one EventMessage for each chunk. Without `since`, it
   * starts at the time of the engine clock before its request, so no event
   * after it resolves is lost (ADR 0017). The signal destroys the stream
   * with its reason.
   */
  async watch(
    options: CancelOptions & { since?: number; filters?: Filters } = {},
  ): Promise<Readable> {
    const { filters, signal } = options;
    const since = options.since ?? (await this.#engineTime(options));
    const response = await this.#client.stream('GET', '/events', {
      query: { since, filters },
      signal,
    });
    const events = new NdjsonDecoder();
    // A destroy of either stream destroys the other, and the response's error goes to the events.
    pipeline(response, events, () => {});
    return events;
  }

  /** The time of the engine clock, in seconds since the Unix epoch. */
  async #engineTime(options: CancelOptions): Promise<number> {
    const { SystemTime } = await this.info(options);
    return Date.parse(SystemTime ?? '') / 1000;
  }

  /**
   * Closes the connections of the client, also each attach, exec, followed
   * logs and events: an iteration of one of them rejects with a
   * ClientDisposedError. A request in flight, and each request after the
   * disposal starts, rejects with the same ClientDisposedError. It resolves
   * when each connection is closed; for an SSH engine, also the SSH
   * connection, unless other processes share it by ControlMaster: then it ends
   * this process's use, and the connection closes when the last process lets
   * go.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.#client.close();
  }
}
