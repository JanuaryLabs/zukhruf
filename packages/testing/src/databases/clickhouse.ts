import { timebox } from '../async/timebox.ts';
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
        healthy: (service) =>
          timebox(
            () =>
              succeeded(service.container, [
                'clickhouse-client',
                '--query',
                'SELECT 1',
              ]),
            { maxRetryTime: 60_000 },
          ),
      },
    );
  }
}
