import { randomUUID } from 'node:crypto';

import type { Created } from './containers.ts';
import type * as EngineApi from './engine-api.ts';
import { type EngineClient, isSuccess, parseBody } from './engine-client.ts';
import {
  NameConflictError,
  VolumeInUseError,
  VolumeNotFoundError,
} from './errors.ts';
import type { CancelOptions, Filters } from './options.ts';

/**
 * The creation label. The engine answers a create with a taken name with the
 * existing volume, so a random value of this label tells a new volume from an
 * existing one.
 */
const CREATION_LABEL = 'dev.zukhruf.docker.creation';

/** A volume, by its name: a volume has no ID. It has no disposal. */
export class Volume {
  readonly name: string;
  readonly #client: EngineClient;

  constructor(client: EngineClient, name: string) {
    this.#client = client;
    this.name = name;
  }

  get #path(): string {
    return `/volumes/${encodeURIComponent(this.name)}`;
  }

  async inspect(options: CancelOptions = {}): Promise<EngineApi.Volume> {
    const method = 'GET';
    const path = this.#path;
    const response = await this.#client.exchange(method, path, options);
    if (isSuccess(response)) return parseBody<EngineApi.Volume>(response);
    const error = this.#client.error(response, method, path);
    if (response.status === 404) {
      throw new VolumeNotFoundError(error.message, error, this.name, {
        cause: error,
      });
    }
    throw error;
  }

  /** Resolves for 404. Rejects with VolumeInUseError while a container uses the volume. */
  async remove(
    options: CancelOptions & { force?: boolean } = {},
  ): Promise<void> {
    const method = 'DELETE';
    const path = this.#path;
    const response = await this.#client.exchange(method, path, {
      query: { force: options.force },
      signal: options.signal,
    });
    if (isSuccess(response) || response.status === 404) return;
    const error = this.#client.error(response, method, path);
    if (response.status === 409) {
      throw new VolumeInUseError(error.message, error, this.name, {
        cause: error,
      });
    }
    throw error;
  }
}

/** A volume that this handle created. Disposal removes it. */
export class OwnedVolume extends Volume implements AsyncDisposable {
  /** remove() */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.remove();
  }
}

/** The volumes of one engine. */
export class Volumes {
  readonly #client: EngineClient;

  constructor(client: EngineClient) {
    this.#client = client;
  }

  /**
   * Rejects with NameConflictError when the name is taken. The engine answers
   * that create with the existing volume and 201, so the error has the status
   * 201.
   */
  async create(
    body: EngineApi.VolumeCreateRequest = {},
    options: CancelOptions = {},
  ): Promise<OwnedVolume> {
    const { created, name, status } = await this.#create(body, options);
    if (created) return new OwnedVolume(this.#client, name);
    throw new NameConflictError(
      `A volume with the name ${name} already exists.`,
      { status, request: { method: 'POST', path: '/volumes/create' } },
      'volume',
      name,
    );
  }

  /** Creates the volume, or gives the one that has the name. The volume that exists wins. */
  async createOrGet(
    body: EngineApi.VolumeCreateRequest & { Name: string },
    options: CancelOptions = {},
  ): Promise<Created<'volume', OwnedVolume, Volume>> {
    const { created, name } = await this.#create(body, options);
    return created
      ? { created: true, volume: new OwnedVolume(this.#client, name) }
      : { created: false, volume: new Volume(this.#client, name) };
  }

  /** One inspect: a handle, or undefined for 404. */
  async find(
    name: string,
    options: CancelOptions = {},
  ): Promise<Volume | undefined> {
    const method = 'GET';
    const path = `/volumes/${encodeURIComponent(name)}`;
    const response = await this.#client.exchange(method, path, options);
    if (response.status === 404) return undefined;
    if (!isSuccess(response)) throw this.#client.error(response, method, path);
    return new Volume(this.#client, parseBody<EngineApi.Volume>(response).Name);
  }

  async list(
    options: CancelOptions & { filters?: Filters } = {},
  ): Promise<EngineApi.Volume[]> {
    const { Volumes } = await this.#client.json<EngineApi.VolumeListResponse>(
      'GET',
      '/volumes',
      { query: { filters: options.filters }, signal: options.signal },
    );
    return Volumes ?? [];
  }

  /** Sends the create with a new creation label. The label of the answer tells whether this call created the volume. */
  async #create(
    body: EngineApi.VolumeCreateRequest,
    options: CancelOptions,
  ): Promise<{ created: boolean; name: string; status: number }> {
    const creation = randomUUID();
    const method = 'POST';
    const path = '/volumes/create';
    const response = await this.#client.exchange(method, path, {
      body: { ...body, Labels: { ...body.Labels, [CREATION_LABEL]: creation } },
      signal: options.signal,
    });
    if (!isSuccess(response)) throw this.#client.error(response, method, path);
    const volume = parseBody<EngineApi.Volume>(response);
    return {
      created: volume.Labels?.[CREATION_LABEL] === creation,
      name: volume.Name,
      status: response.status,
    };
  }
}
