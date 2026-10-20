import type { Container, Created } from './containers.ts';
import type * as EngineApi from './engine-api.ts';
import { type EngineClient, isSuccess, parseBody } from './engine-client.ts';
import {
  ContainerNotFoundError,
  NameConflictError,
  NetworkInUseError,
  NetworkNotFoundError,
} from './errors.ts';
import type { CancelOptions, Filters } from './options.ts';

/** The networks that the engine defines and never removes: runconfig.IsPreDefinedNetwork of Moby. */
const PREDEFINED_NETWORKS = new Set(['bridge', 'host', 'none']);

/** A network, by the ID that the engine gave it. It has no disposal. */
export class Network {
  readonly id: string;
  readonly #client: EngineClient;

  constructor(client: EngineClient, id: string) {
    this.#client = client;
    this.id = id;
  }

  get #path(): string {
    return `/networks/${encodeURIComponent(this.id)}`;
  }

  async inspect(
    options: CancelOptions = {},
  ): Promise<EngineApi.NetworkInspect> {
    const method = 'GET';
    const path = this.#path;
    const response = await this.#client.exchange(method, path, options);
    if (isSuccess(response)) {
      return parseBody<EngineApi.NetworkInspect>(response);
    }
    const error = this.#client.error(response, method, path);
    if (response.status !== 404) throw error;
    throw new NetworkNotFoundError(error.message, error, this.id, {
      cause: error,
    });
  }

  async connect(
    container: Container,
    endpoint?: EngineApi.NetworkConnectRequest['EndpointConfig'],
    options: CancelOptions = {},
  ): Promise<void> {
    const body = { Container: container.id, EndpointConfig: endpoint };
    await this.#endpoint('connect', container, body, options);
  }

  async disconnect(
    container: Container,
    options: CancelOptions & { force?: boolean } = {},
  ): Promise<void> {
    const body = { Container: container.id, Force: options.force };
    await this.#endpoint('disconnect', container, body, options);
  }

  /**
   * Resolves for 404. A 403 is a pre-defined network or a network with
   * connected containers: an inspect tells which. A pre-defined network can
   * have connected containers too, so its name decides first. Only a running
   * container has an endpoint, so only a running one keeps the network.
   */
  async remove(options: CancelOptions = {}): Promise<void> {
    const method = 'DELETE';
    const path = this.#path;
    const response = await this.#client.exchange(method, path, options);
    if (isSuccess(response) || response.status === 404) return;
    const error = this.#client.error(response, method, path);
    if (response.status !== 403) throw error;
    const inspect = await this.#client.exchange('GET', path, options);
    if (inspect.status === 404) return;
    if (!isSuccess(inspect)) throw error;
    const network = parseBody<EngineApi.NetworkInspect>(inspect);
    if (PREDEFINED_NETWORKS.has(network.Name)) throw error;
    const containers = Object.keys(network.Containers ?? {});
    if (containers.length === 0) throw error;
    throw new NetworkInUseError(error.message, error, this.id, containers, {
      cause: error,
    });
  }

  /**
   * A 404 of a connect or a disconnect is a missing network or a missing
   * container: an inspect of the network tells which. An engine in swarm mode
   * answers a missing network with 500 ("Could not attach to network", probed
   * at API 1.51), so a 500 gets the same inspect.
   */
  async #endpoint(
    action: 'connect' | 'disconnect',
    container: Container,
    body: object,
    options: CancelOptions,
  ): Promise<void> {
    const method = 'POST';
    const path = `${this.#path}/${action}`;
    const response = await this.#client.exchange(method, path, {
      body,
      signal: options.signal,
    });
    if (isSuccess(response)) return;
    const error = this.#client.error(response, method, path);
    if (response.status !== 404 && response.status !== 500) throw error;
    const inspect = await this.#client.exchange('GET', this.#path, options);
    if (inspect.status === 404) {
      throw new NetworkNotFoundError(error.message, error, this.id, {
        cause: error,
      });
    }
    if (response.status === 500) throw error;
    throw new ContainerNotFoundError(error.message, error, container.id, {
      cause: error,
    });
  }
}

/** A network that this handle created. Disposal removes it. */
export class OwnedNetwork extends Network implements AsyncDisposable {
  /** remove() */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.remove();
  }
}

/** The networks of one engine. */
export class Networks {
  readonly #client: EngineClient;

  constructor(client: EngineClient) {
    this.#client = client;
  }

  /** From API 1.44, the engine refuses a taken name with 409: it rejects with NameConflictError. */
  async create(
    body: EngineApi.NetworkCreateRequest,
    options: CancelOptions = {},
  ): Promise<OwnedNetwork> {
    const method = 'POST';
    const path = '/networks/create';
    const response = await this.#client.exchange(method, path, {
      body,
      signal: options.signal,
    });
    if (isSuccess(response)) {
      const { Id } = parseBody<{ Id: string }>(response);
      return new OwnedNetwork(this.#client, Id);
    }
    const error = this.#client.error(response, method, path);
    if (response.status === 409) {
      throw new NameConflictError(error.message, error, 'network', body.Name, {
        cause: error,
      });
    }
    throw error;
  }

  /**
   * Creates the network, or gives the one that has the name. The network that
   * exists wins. When that network is removed between the 409 and the
   * inspect, the create runs again.
   */
  async createOrGet(
    body: EngineApi.NetworkCreateRequest,
    options: CancelOptions = {},
  ): Promise<Created<'network', OwnedNetwork, Network>> {
    for (;;) {
      try {
        return { created: true, network: await this.create(body, options) };
      } catch (error) {
        if (!(error instanceof NameConflictError)) throw error;
      }
      const network = await this.find(body.Name, options);
      if (network) return { created: false, network };
    }
  }

  /** One inspect: a handle with the ID of the engine, or undefined for 404. */
  async find(
    nameOrId: string,
    options: CancelOptions = {},
  ): Promise<Network | undefined> {
    const method = 'GET';
    const path = `/networks/${encodeURIComponent(nameOrId)}`;
    const response = await this.#client.exchange(method, path, options);
    if (response.status === 404) return undefined;
    if (!isSuccess(response)) throw this.#client.error(response, method, path);
    const { Id } = parseBody<EngineApi.NetworkInspect>(response);
    return new Network(this.#client, Id);
  }

  async list(
    options: CancelOptions & { filters?: Filters } = {},
  ): Promise<EngineApi.NetworkSummary[]> {
    return this.#client.json<EngineApi.NetworkSummary[]>('GET', '/networks', {
      query: { filters: options.filters },
      signal: options.signal,
    });
  }
}
