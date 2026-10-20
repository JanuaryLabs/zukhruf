import type * as EngineApi from './engine-api.ts';
import { type EngineClient, isSuccess, parseBody } from './engine-client.ts';
import { DockerEngineError, ImageNotFoundError } from './errors.ts';
import type { CancelOptions } from './options.ts';
import { readProgress } from './progress.ts';

/**
 * A reference with no tag and no digest pulls each tag of the repository, so
 * the pull names the tag 'latest', as the Docker CLI does.
 */
function pullQuery(reference: string, platform: string | undefined) {
  const lastPart = reference.slice(reference.lastIndexOf('/') + 1);
  const tagged = reference.includes('@') || lastPart.includes(':');
  return { fromImage: reference, tag: tagged ? undefined : 'latest', platform };
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
            { status: 404, method, path },
            reference,
            { cause: error },
          );
        }
        throw error;
      });
    await readProgress(progress, { method, path });
  }
}
