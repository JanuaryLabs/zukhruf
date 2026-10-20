import { setTimeout } from 'node:timers/promises';

import type * as EngineApi from './engine-api.ts';
import {
  type EngineClient,
  type EngineResponse,
  isSuccess,
  parseBody,
} from './engine-client.ts';
import {
  BindSourceNotFoundError,
  ContainerNotFoundError,
  ContainerNotRunningError,
  ContainerRunningError,
  type DockerEngineError,
  ImageNotFoundError,
  NameConflictError,
  NetworkNotFoundError,
} from './errors.ts';
import type { Images } from './images.ts';
import type { CancelOptions, Filters } from './options.ts';

/** The result of createOrGet(): an owned handle when this call created the resource. */
export type Created<Key extends string, Owned, Found> =
  | ({ created: true } & Record<Key, Owned>)
  | ({ created: false } & Record<Key, Found>);

/** The time between two tries of createOrGet() while the name is taken but an inspect does not find it. */
const NAME_RACE_DELAY_MS = 20;

/** The fixed text of Moby for a missing bind source: errBindSourceDoesNotExist in daemon/volume/mounts/validate.go. */
const BIND_SOURCE_NOT_FOUND = /bind source path does not exist: (.+)$/;

/**
 * The BindSourceNotFoundError of an answer, or the DockerEngineError. The
 * engine gives a missing bind source the status of each bad parameter, so
 * only its text tells it apart.
 */
function bindSourceOr(error: DockerEngineError): DockerEngineError {
  const source = BIND_SOURCE_NOT_FOUND.exec(error.message)?.[1];
  if (source === undefined) return error;
  return new BindSourceNotFoundError(
    error.message,
    { status: error.status, method: error.method, path: error.path },
    source,
    { cause: error },
  );
}

/** The address of the loopback interface of the same family, for an address that binds each interface. */
function reachableHost(hostIp: string | undefined): string {
  if (hostIp === undefined || hostIp === '' || hostIp === '0.0.0.0') {
    return '127.0.0.1';
  }
  if (hostIp === '::') return '::1';
  return hostIp;
}

/** The network modes that name no network of the caller. */
const PREDEFINED_NETWORK_MODES = new Set(['default', 'bridge', 'host', 'none']);

/**
 * The names of the networks of a container: its network mode, when it names a
 * network, and each network of its endpoints.
 */
function networksOf(container: EngineApi.ContainerInspectResponse): string[] {
  const mode = container.HostConfig?.NetworkMode;
  const networks = new Set<string>();
  if (
    mode !== undefined &&
    mode !== '' &&
    !PREDEFINED_NETWORK_MODES.has(mode) &&
    !mode.startsWith('container:')
  ) {
    networks.add(mode);
  }
  for (const name of Object.keys(container.NetworkSettings?.Networks ?? {})) {
    networks.add(name);
  }
  return [...networks];
}

/** A container, by the ID that the engine gave it. It has no disposal. */
export class Container {
  readonly id: string;
  readonly #client: EngineClient;

  constructor(client: EngineClient, id: string) {
    this.#client = client;
    this.id = id;
  }

  get #path(): string {
    return `/containers/${encodeURIComponent(this.id)}`;
  }

  async inspect(
    options: CancelOptions = {},
  ): Promise<EngineApi.ContainerInspectResponse> {
    const method = 'GET';
    const path = `${this.#path}/json`;
    const response = await this.#client.exchange(method, path, options);
    this.#throwUnless(response, method, path);
    return parseBody<EngineApi.ContainerInspectResponse>(response);
  }

  /**
   * Resolves for 304 (already running). A 404 is a missing container or a
   * missing network: an inspect of the container tells which, and a lookup of
   * each of its networks names the missing one. An engine in swarm mode
   * answers a missing network with 500 ("Could not attach to network", probed
   * at API 1.51), so a 500 gets the same lookup.
   */
  async start(options: CancelOptions = {}): Promise<void> {
    const { signal } = options;
    const method = 'POST';
    const path = `${this.#path}/start`;
    const response = await this.#client.exchange(method, path, { signal });
    if (response.status === 304 || isSuccess(response)) return;
    const error = this.#client.error(response, method, path);
    if (response.status !== 404 && response.status !== 500) {
      throw bindSourceOr(error);
    }
    const inspect = await this.#client.exchange('GET', `${this.#path}/json`, {
      signal,
    });
    if (inspect.status === 404 && response.status === 404) {
      this.#throwUnless(response, method, path);
    }
    if (!isSuccess(inspect)) throw bindSourceOr(error);
    const container = parseBody<EngineApi.ContainerInspectResponse>(inspect);
    for (const network of networksOf(container)) {
      const lookup = await this.#client.exchange(
        'GET',
        `/networks/${encodeURIComponent(network)}`,
        { signal },
      );
      if (lookup.status === 404) {
        throw new NetworkNotFoundError(
          error.message,
          { status: response.status, method, path },
          network,
          { cause: error },
        );
      }
    }
    throw bindSourceOr(error);
  }

  /** Resolves for 304 (already stopped). t: seconds before the engine kills the main process. */
  async stop(options: CancelOptions & { t?: number } = {}): Promise<void> {
    const method = 'POST';
    const path = `${this.#path}/stop`;
    const response = await this.#client.exchange(method, path, {
      query: { t: options.t },
      signal: options.signal,
    });
    if (response.status === 304) return;
    this.#throwUnless(response, method, path);
  }

  async restart(options: CancelOptions & { t?: number } = {}): Promise<void> {
    await this.#post('restart', { t: options.t }, options);
  }

  /** A 409 means that the container does not run: an inspect gives its state. */
  async kill(
    processSignal = 'SIGKILL',
    options: CancelOptions = {},
  ): Promise<void> {
    const method = 'POST';
    const path = `${this.#path}/kill`;
    const response = await this.#client.exchange(method, path, {
      query: { signal: processSignal },
      signal: options.signal,
    });
    if (response.status === 409) {
      const state = (await this.inspect(options)).State?.Status ?? '';
      const error = this.#client.error(response, method, path);
      throw new ContainerNotRunningError(
        error.message,
        { status: 409, method, path },
        this.id,
        state,
        { cause: error },
      );
    }
    this.#throwUnless(response, method, path);
  }

  async pause(options: CancelOptions = {}): Promise<void> {
    await this.#post('pause', {}, options);
  }

  async unpause(options: CancelOptions = {}): Promise<void> {
    await this.#post('unpause', {}, options);
  }

  async wait(
    options: CancelOptions & {
      condition?: 'not-running' | 'next-exit' | 'removed';
    } = {},
  ): Promise<EngineApi.ContainerWaitResponse> {
    const method = 'POST';
    const path = `${this.#path}/wait`;
    const response = await this.#client.exchange(method, path, {
      query: { condition: options.condition },
      signal: options.signal,
    });
    this.#throwUnless(response, method, path);
    return parseBody<EngineApi.ContainerWaitResponse>(response);
  }

  /**
   * Resolves for 404. A 409 is a removal that is already in progress, or,
   * without `force`, a container that runs: an inspect tells which. For a
   * removal in progress, it waits until the container is gone. A container
   * that runs or is paused rejects with ContainerRunningError. The engine
   * gives the state 'running' while it kills the container for a forced
   * removal, so with `force` the state alone does not tell: it waits.
   */
  async remove(
    options: CancelOptions & { force?: boolean; v?: boolean } = {},
  ): Promise<void> {
    const { force, signal } = options;
    const method = 'DELETE';
    const path = this.#path;
    const response = await this.#client.exchange(method, path, {
      query: { force, v: options.v },
      signal,
    });
    if (isSuccess(response) || response.status === 404) return;
    const error = this.#client.error(response, method, path);
    if (response.status !== 409) throw error;
    const inspect = await this.#client.exchange('GET', `${path}/json`, {
      signal,
    });
    if (inspect.status === 404) return;
    const state = parseBody<EngineApi.ContainerInspectResponse>(inspect).State;
    const runs = state?.Running === true || state?.Paused === true;
    if (force !== true && runs) {
      throw new ContainerRunningError(
        error.message,
        { status: 409, method, path },
        this.id,
        { cause: error },
      );
    }
    const gone = await this.#client.exchange('POST', `${path}/wait`, {
      query: { condition: 'removed' },
      signal,
    });
    if (isSuccess(gone) || gone.status === 404) return;
    throw error;
  }

  /** The published binding of a port of the container; undefined when it is not published. The IPv4 binding comes first. */
  async port(
    containerPort: number,
    protocol: 'tcp' | 'udp' = 'tcp',
    options: CancelOptions = {},
  ): Promise<{ host: string; port: number } | undefined> {
    const { NetworkSettings } = await this.inspect(options);
    const bindings = (
      NetworkSettings?.Ports?.[`${containerPort}/${protocol}`] ?? []
    ).filter((binding) => binding.HostPort);
    const binding =
      bindings.find((each) => !each.HostIp?.includes(':')) ?? bindings[0];
    if (binding === undefined) return undefined;
    return {
      host: reachableHost(binding.HostIp),
      port: Number(binding.HostPort),
    };
  }

  async #post(
    action: string,
    query: Record<string, number | undefined>,
    options: CancelOptions,
  ): Promise<void> {
    const method = 'POST';
    const path = `${this.#path}/${action}`;
    const response = await this.#client.exchange(method, path, {
      query,
      signal: options.signal,
    });
    this.#throwUnless(response, method, path);
  }

  /** A 2xx passes; a 404 is a ContainerNotFoundError; each other status is a DockerEngineError. */
  #throwUnless(response: EngineResponse, method: string, path: string): void {
    if (isSuccess(response)) return;
    const error = this.#client.error(response, method, path);
    if (response.status === 404) {
      throw new ContainerNotFoundError(
        error.message,
        { status: 404, method, path },
        this.id,
        { cause: error },
      );
    }
    throw error;
  }
}

/** A container that this handle created. Disposal removes it with its anonymous volumes. */
export class OwnedContainer extends Container implements AsyncDisposable {
  /** remove({ force: true, v: true }) */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.remove({ force: true, v: true });
  }
}

/** The containers of one engine. */
export class Containers {
  readonly #client: EngineClient;
  readonly #images: Images;

  constructor(client: EngineClient, images: Images) {
    this.#client = client;
    this.#images = images;
  }

  async create(
    body: EngineApi.ContainerCreateRequest,
    options: CancelOptions & { name?: string; platform?: string } = {},
  ): Promise<OwnedContainer> {
    const { name, platform, signal } = options;
    const method = 'POST';
    const path = '/containers/create';
    const response = await this.#client.exchange(method, path, {
      query: { name, platform },
      body,
      signal,
    });
    if (isSuccess(response)) {
      const { Id } = parseBody<EngineApi.ContainerCreateResponse>(response);
      return new OwnedContainer(this.#client, Id);
    }
    const error = this.#client.error(response, method, path);
    const request = { status: response.status, method, path };
    if (response.status === 409 && name !== undefined) {
      throw new NameConflictError(error.message, request, 'container', name, {
        cause: error,
      });
    }
    if (response.status === 404 && body.Image !== undefined) {
      const image = await this.#images.inspect(body.Image, options);
      if (image === undefined) {
        throw new ImageNotFoundError(error.message, request, body.Image, {
          cause: error,
        });
      }
    }
    throw bindSourceOr(error);
  }

  /** Creates the container, or gives the one that has the name. The container that exists wins. */
  async createOrGet(
    body: EngineApi.ContainerCreateRequest,
    options: CancelOptions & { name: string; platform?: string },
  ): Promise<Created<'container', OwnedContainer, Container>> {
    const { signal } = options;
    for (;;) {
      try {
        return { created: true, container: await this.create(body, options) };
      } catch (error) {
        if (!(error instanceof NameConflictError)) throw error;
      }
      // A competing create reserves the name before an inspect finds it.
      const container = await this.find(options.name, options);
      if (container) return { created: false, container };
      await setTimeout(NAME_RACE_DELAY_MS, undefined, { signal });
    }
  }

  /** One inspect: a handle with the ID of the engine, or undefined for 404. */
  async find(
    nameOrId: string,
    options: CancelOptions = {},
  ): Promise<Container | undefined> {
    const method = 'GET';
    const path = `/containers/${encodeURIComponent(nameOrId)}/json`;
    const response = await this.#client.exchange(method, path, options);
    if (response.status === 404) return undefined;
    if (!isSuccess(response)) throw this.#client.error(response, method, path);
    const { Id } = parseBody<EngineApi.ContainerInspectResponse>(response);
    return new Container(this.#client, Id);
  }

  async list(
    options: CancelOptions & { all?: boolean; filters?: Filters } = {},
  ): Promise<EngineApi.ContainerSummary[]> {
    return this.#client.json<EngineApi.ContainerSummary[]>(
      'GET',
      '/containers/json',
      {
        query: { all: options.all, filters: options.filters },
        signal: options.signal,
      },
    );
  }
}
