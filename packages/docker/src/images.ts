import { Readable } from 'node:stream';

import type * as EngineApi from './engine-api.ts';
import { type EngineClient, isSuccess, parseBody } from './engine-client.ts';
import {
  DockerEngineError,
  ImageInUseError,
  ImageNotFoundError,
} from './errors.ts';
import type { CancelOptions, Filters } from './options.ts';
import { readProgress } from './progress.ts';

/**
 * The repository and the tag of a reference. A reference with a digest has no
 * tag, and its repository is the whole reference.
 */
function splitReference(reference: string): {
  repository: string;
  tag: string | undefined;
} {
  const colon = reference.lastIndexOf(':');
  if (reference.includes('@') || colon <= reference.lastIndexOf('/')) {
    return { repository: reference, tag: undefined };
  }
  return {
    repository: reference.slice(0, colon),
    tag: reference.slice(colon + 1),
  };
}

/**
 * A reference with no tag and no digest pulls each tag of the repository, so
 * the pull names the tag 'latest', as the Docker CLI does.
 */
function pullQuery(reference: string, platform: string | undefined) {
  const bare =
    !reference.includes('@') && splitReference(reference).tag === undefined;
  return { fromImage: reference, tag: bare ? 'latest' : undefined, platform };
}

/** The images of one engine. Images have no owner, so no handle removes one on disposal. */
export class Images {
  readonly #client: EngineClient;

  constructor(client: EngineClient) {
    this.#client = client;
  }

  /** undefined for 404. */
  async inspect(
    reference: string,
    options: CancelOptions = {},
  ): Promise<EngineApi.ImageInspect | undefined> {
    const method = 'GET';
    const path = `/images/${encodeURIComponent(reference)}/json`;
    const response = await this.#client.exchange(method, path, options);
    if (response.status === 404) return undefined;
    if (!isSuccess(response)) throw this.#client.error(response, method, path);
    return parseBody<EngineApi.ImageInspect>(response);
  }

  /** Pulls the image and reads the progress of the engine to its end. */
  async pull(
    reference: string,
    options: CancelOptions & {
      platform?: string;
      auth?: EngineApi.AuthConfig;
    } = {},
  ): Promise<void> {
    const { platform, auth, signal } = options;
    const method = 'POST';
    const path = '/images/create';
    const progress = await this.#client
      .stream(method, path, {
        query: pullQuery(reference, platform),
        // The same X-Registry-Auth encoding is in push(): mirror a fix in both.
        headers:
          auth === undefined
            ? undefined
            : {
                'X-Registry-Auth': Buffer.from(JSON.stringify(auth)).toString(
                  'base64url',
                ),
              },
        signal,
      })
      .catch((error: unknown) => {
        if (error instanceof DockerEngineError && error.status === 404) {
          throw new ImageNotFoundError(
            error.message,
            { status: 404, request: { method, path } },
            reference,
            { cause: error },
          );
        }
        throw error;
      });
    await readProgress(progress, { method, path });
  }

  list(
    options: CancelOptions & { all?: boolean; filters?: Filters } = {},
  ): Promise<EngineApi.ImageSummary[]> {
    return this.#client.json<EngineApi.ImageSummary[]>('GET', '/images/json', {
      query: { all: options.all, filters: options.filters },
      signal: options.signal,
    });
  }

  /** Gives the image a second name, such as a registry name before a push. target: 'repository:tag'; with no tag, the tag is 'latest', as the Docker CLI does. */
  async tag(
    reference: string,
    target: string,
    options: CancelOptions = {},
  ): Promise<void> {
    const method = 'POST';
    const path = `/images/${encodeURIComponent(reference)}/tag`;
    const { repository, tag = 'latest' } = splitReference(target);
    const response = await this.#client.exchange(method, path, {
      query: { repo: repository, tag },
      signal: options.signal,
    });
    if (isSuccess(response)) return;
    const error = this.#client.error(response, method, path);
    if (response.status === 404) {
      throw new ImageNotFoundError(error.message, error, reference, {
        cause: error,
      });
    }
    throw error;
  }

  /**
   * Pushes the image and reads the progress of the engine to its end. The
   * engine answers a push of an image that it does not have with 200, and
   * then reports the error in the progress: an inspect of the reference tells
   * a missing image from another error.
   */
  async push(
    reference: string,
    options: CancelOptions & { auth: EngineApi.AuthConfig },
  ): Promise<void> {
    const { auth, signal } = options;
    const { repository, tag = 'latest' } = splitReference(reference);
    const method = 'POST';
    const path = `/images/${encodeURIComponent(repository)}/push`;
    try {
      const progress = await this.#client.stream(method, path, {
        query: { tag },
        // The same X-Registry-Auth encoding is in pull(): mirror a fix in both.
        headers: {
          'X-Registry-Auth': Buffer.from(JSON.stringify(auth)).toString(
            'base64url',
          ),
        },
        signal,
      });
      await readProgress(progress, { method, path });
    } catch (error) {
      if (!(error instanceof DockerEngineError)) throw error;
      const missing =
        error.status === 404 ||
        (error.status === undefined &&
          (await this.inspect(reference, options)) === undefined);
      if (!missing) throw error;
      throw new ImageNotFoundError(error.message, error, reference, {
        cause: error,
      });
    }
  }

  /** A tar archive of the images, as `docker save` writes it. */
  async save(
    references: string[],
    options: CancelOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await this.#client.stream('GET', '/images/get', {
      query: { names: references },
      signal: options.signal,
    });
    return Readable.toWeb(response);
  }

  /** Loads the images of a tar archive and reads the progress of the engine to its end. */
  async load(
    archive: ReadableStream<Uint8Array> | Uint8Array,
    options: CancelOptions = {},
  ): Promise<void> {
    const method = 'POST';
    const path = '/images/load';
    const progress = await this.#client.stream(method, path, {
      content: { type: 'application/x-tar', data: archive },
      signal: options.signal,
    });
    await readProgress(progress, { method, path });
  }

  /** Resolves for 404. A 409 is an ImageInUseError: a container uses the image, or, by ID, several names refer to it. */
  async remove(
    reference: string,
    options: CancelOptions & { force?: boolean; noprune?: boolean } = {},
  ): Promise<void> {
    const method = 'DELETE';
    const path = `/images/${encodeURIComponent(reference)}`;
    const response = await this.#client.exchange(method, path, {
      query: { force: options.force, noprune: options.noprune },
      signal: options.signal,
    });
    if (isSuccess(response) || response.status === 404) return;
    const error = this.#client.error(response, method, path);
    if (response.status === 409) {
      throw new ImageInUseError(error.message, error, reference, {
        cause: error,
      });
    }
    throw error;
  }
}
