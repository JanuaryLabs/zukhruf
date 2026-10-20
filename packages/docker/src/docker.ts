import { negotiateApiVersion } from './api-version.ts';
import {
  type DockerContext,
  type Environment,
  listContexts,
  selectEngine,
} from './context-store.ts';
import type * as EngineApi from './engine-api.ts';
import { EngineClient } from './engine-client.ts';
import { parseHost } from './host.ts';
import type { CancelOptions } from './options.ts';
import { SshTransport } from './ssh-connection.ts';
import { SocketTransport, type Transport } from './transport.ts';

/** A context or a host, never both. */
export type ConnectOptions = CancelOptions & { environment?: Environment } & (
    { context?: string; host?: never } | { host?: string; context?: never }
  );

/** A client of one engine. Dispose it to close its connections. */
export class Docker implements AsyncDisposable {
  /** The context that selected the engine: 'default' for DOCKER_HOST or a host option. */
  readonly context: string;
  readonly host: string;
  readonly apiVersion: string;
  /** Sends the Docker CLI to this engine: { DOCKER_HOST, DOCKER_CONTEXT: undefined }. */
  readonly cliEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #client: EngineClient;
  readonly #transport: Transport;

  private constructor(
    context: string,
    host: string,
    apiVersion: string,
    client: EngineClient,
    transport: Transport,
  ) {
    this.context = context;
    this.host = host;
    this.apiVersion = apiVersion;
    this.cliEnvironment = Object.freeze({
      DOCKER_HOST: host,
      DOCKER_CONTEXT: undefined,
    });
    this.#client = client;
    this.#transport = transport;
  }

  /** Selects the engine in the order of the Docker CLI, pings it and negotiates the API version. */
  static async connect(options: ConnectOptions = {}): Promise<Docker> {
    const { signal } = options;
    const engine = await selectEngine(options);
    const parsed = parseHost(engine.host);
    const transport =
      parsed.kind === 'ssh'
        ? new SshTransport(parsed.url)
        : new SocketTransport(parsed.socketPath);
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
        transport,
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

  /** Closes the connections of the client. For an SSH engine, it resolves when each `ssh` process exited. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.#transport.close();
  }
}
