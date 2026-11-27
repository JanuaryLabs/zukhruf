import { retryUntilReady } from '../async/retry-until-ready.ts';
import type { ServiceContainer } from '../docker/service-container.ts';
import { DockerTestbed, type DockerTestbedOptions } from '../docker/testbed.ts';
import { succeeded } from './succeeded.ts';

/** Each start owns a dedicated ClickHouse server and its disposable container. */
export class ClickHouse {
  readonly #docker: DockerTestbed;
  readonly #image: string;

  constructor({
    environment,
    image,
  }: DockerTestbedOptions & { image: string }) {
    this.#docker = new DockerTestbed({ environment });
    this.#image = image;
  }

  start(): Promise<ServiceContainer> {
    return this.#docker.serve(
      {
        Image: this.#image,
        Env: ['CLICKHOUSE_SKIP_USER_SETUP=1'],
        HostConfig: { Memory: 2 * 1024 ** 3 },
      },
      {
        internalPort: 8123,
        // The server logs to /var/log/clickhouse-server, so its console
        // gets no ready line: poll a query, within the limit of the wait.
        wait: {
          until: async (service, signal) => {
            await retryUntilReady(
              () =>
                succeeded(service.container, [
                  'clickhouse-client',
                  '--query',
                  'SELECT 1',
                ]),
              { maxRetryTime: Number.POSITIVE_INFINITY, signal },
            );
          },
          timeout: 60_000,
        },
      },
    );
  }
}
